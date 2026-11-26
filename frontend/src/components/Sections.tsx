// Landing sections — the pay flow lives on /dashboard now (fix-back-12);
// nothing on this page pays anything. P2 §4.2 section mapping + design §3/§5.
// Features: 4-column card row with shared hairlines + corner handle squares
// (design §2: 5px ink squares on every outer corner via .handles + <i>).
// How it works: 3 step cards, each with a visual slot over the dawn-terrain
// image (design §5): 01 payables list with a cycling highlighted row (1.2 s,
// only while in view), 02 connector diagram (3 sources → 9 checks, amber
// dots travel the wires), 03 the two payment rails. Card 04: floating
// notification over terrain with the latest real payment. Receipt checker:
// 5 stages from a real after-pay verify call, 0.9 s apart, replay button.
import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, CheckCircle2, Receipt, RotateCcw, ShieldAlert, ShieldCheck, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useConfig, useInvoices, useReceipt } from '../hooks/useApi'
import { api } from '../lib/api'
import { COPY } from '../lib/copy'
import { formatUtcDateTime, formatUtcTime } from '../lib/format'
import { RECORDED_DATE, RECORDED_REFUSALS } from '../lib/recorded'
import { EXPLORER_HOME, EXPLORER_TX } from '../lib/tokens'
import { Reveal, useSlowLoad } from './polish'
import { HairlineFigure } from './HairlineFigure'
import { Logo } from './Logo'
import { evidenceGap } from '../lib/receiptVerdict'
import type { InvoiceItem, VerifyResponse } from '../lib/types'

/** The ONE "latest payment" rule, shared by the step-04 card and the
    receipt checker: the highest-id paid payable. The list carries no
    paid_at, so the most recently created paid payable (highest id) is the
    latest: ids are sequential and the paid set was paid in id order
    (1006 paid 15:08 UTC, after 1005 13:20 UTC). The checker used to take
    paid[0] — the first paid row in API list order — which could be an
    older payment than the card's "latest". */
export function latestPaidInvoice(items: InvoiceItem[]): InvoiceItem | undefined {
  return [...items].filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id)[0]
}

const FEATURES = [
  {
    icon: Wallet,
    title: 'Pay exactly once',
    body: 'The contract refuses a second payment for the same payable. One payable, one payment, one receipt.',
  },
  {
    icon: ShieldCheck,
    title: 'Seller-bound payments',
    body: 'The payee is read from the chain, never from the document. A payment can only go to the account the seller put there.',
  },
  {
    icon: ShieldAlert,
    title: 'Refusals on chain',
    body: 'A wrong amount or a second payment stops before any money moves — and the refusal itself is on chain, with its code.',
  },
  {
    icon: Receipt,
    title: 'Receipts that re-verify',
    body: 'Every payment gets a receipt with the transaction hash, block and payee — check it again on chain any time.',
  },
]

const STEPS = [
  {
    n: '01',
    title: 'Pick an invoice',
    body: 'Choose a payable from the live registry, load an invoice file, or create a fresh one from the demo budget.',
  },
  {
    n: '02',
    title: 'Check the invoice',
    body: 'Nine checks run against the chain — document hash, agent token and unpaid status — before Pay is enabled.',
  },
  {
    n: '03',
    title: 'Pay once',
    body: 'One transaction on Rail A, or reserve, co-sign and confirm on Rail B. The receipt is yours to re-verify.',
  },
  {
    n: '04',
    title: 'Receipt',
    body: 'The receipt carries the transaction hash, the block and the payee — re-read it on chain any time. A receipt that does not re-verify is not a receipt.',
  },
]

function Terrain({ src, position = 'center' }: { src: string; position?: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      width={1920}
      height={1280}
      className="absolute inset-0 h-full w-full object-cover"
      style={{ objectPosition: position }}
    />
  )
}

export function Features() {
  return (
    <section aria-labelledby="features-title" className="mx-auto max-w-[1101px] px-4 py-28 sm:px-6">
      <Reveal className="text-center">
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Built for clarity
        </p>
        <h2 id="features-title" className="mx-auto mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Four things the chain enforces.
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          The payee is read from the chain, never from the document. The document is evidence, not the instruction.
        </p>
      </Reveal>
      {/* Flat hairline grid with corner squares, like the video's feature
          grid (and the How-it-works grid below) — shared 1px borders, no
          gutters, no glass cards. */}
      <div className="handles hairline-grid mt-14 grid grid-cols-1 border border-line bg-card md:grid-cols-2 lg:grid-cols-4">
        <i aria-hidden="true" />
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.08} className="border border-line bg-card p-8 transition-transform duration-200 hover:-translate-y-1">
            <div className="flex min-h-[248px] flex-col justify-between">
              <f.icon className="h-5 w-5 text-ink" aria-hidden="true" />
              <div className="mt-8">
                <h3 className="text-[20px] leading-tight font-medium tracking-[-0.01em] text-ink">{f.title}</h3>
                <p className="mt-3 max-w-[42ch] text-[15px] leading-[1.6] text-muted">{f.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

/** Proof Wall — the showcase merged into a dual marquee of clickable
    real records (Identity Brief §3 #6, SKILL.md §3 #6). Row 1: paid
    payables, newest first, each linking to its receipt page. Row 2
    (reversed): the 7 recorded refusals of the 24 Nov 2026 run, each
    linking to its explorer transaction. Nothing here is a card grid and
    nothing is invented: an empty registry renders an honest empty state,
    not a placeholder row — but the refusal marquee is static recorded
    data, so it (and the recorded-run caption) render even then, with no
    API. Only the paid marquee is gated on live data. The duplicated track halves are aria-hidden so
    a screen reader hears each record once; under reduced motion the
    marquees become a wrapped static grid (index.css). */
export function ProofWall() {
  const invoices = useInvoices()
  const slow = useSlowLoad(invoices.isLoading)
  const items = invoices.data ?? []
  const paid = [...items].filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id).slice(0, 8)
  const paidTrack = [...paid, ...paid]
  const refusalTrack = [...RECORDED_REFUSALS, ...RECORDED_REFUSALS]
  return (
    <section id="proof" aria-labelledby="proof-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal className="text-center">
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Live from the registry
        </p>
        <h2 id="proof-title" className="mx-auto mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Every payment leaves a record.
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          Paid payables link to their receipts. Refusals link to the explorer transaction that refused them — with
          the chain code, not a paraphrase.
        </p>
      </Reveal>
      {paid.length === 0 && (
        <p className="mt-14 text-center text-[15px] text-muted">
          {invoices.isError
            ? COPY.statsNoData
            : invoices.isLoading
              ? `Loading payables…${slow ? ' Still loading — the test API is slow right now.' : ''}`
              : 'No paid invoices on the test registry right now.'}
        </p>
      )}
      {paid.length > 0 && (
        <div className="mt-14">
          <div className="po-marquee border-y border-line py-3" data-testid="proof-wall-paid">
            <div className="po-marquee__track">
              {paidTrack.map((inv, i) => (
                <Link
                  key={`${inv.payable_id}-${i}`}
                  to={`/receipt/${inv.payable_id}?seller=${inv.seller}`}
                  aria-hidden={i >= paid.length}
                  tabIndex={i >= paid.length ? -1 : undefined}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-line bg-card px-4 py-2 text-[14px] whitespace-nowrap text-ink hover:border-brand-600"
                >
                  <span className="font-medium">Payable {inv.payable_id}</span>
                  <span className="text-body tabular-nums">{inv.amount_display}</span>
                  <span className="rounded-full bg-verified-bg px-2 py-0.5 text-[11px] font-semibold text-verified-fg">
                    Paid once
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* The refusal marquee + recorded-run caption are static recorded
          data (frontend/src/lib/recorded.ts) — they render unconditionally,
          even when the API is down or the registry has zero paid payables.
          Only the paid marquee above is gated on live data. */}
      <div className={paid.length > 0 ? undefined : 'mt-14'}>
        <div className="po-marquee po-marquee--rev border-b border-line py-3" data-testid="proof-wall-refused">
          <div className="po-marquee__track">
            {refusalTrack.map((r, i) => (
              <a
                key={`${r.code}-${i}`}
                href={`${EXPLORER_TX}${r.txHash}`}
                target="_blank"
                rel="noreferrer"
                aria-hidden={i >= RECORDED_REFUSALS.length}
                tabIndex={i >= RECORDED_REFUSALS.length ? -1 : undefined}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-line bg-card px-4 py-2 text-[14px] whitespace-nowrap text-ink hover:border-brand-600"
              >
                <span className="font-medium">
                  {r.code} {r.name}
                </span>
                <span className="font-mono text-xs text-muted">
                  {r.txHash.slice(0, 8)}…{r.txHash.slice(-6)}
                </span>
                <span className="rounded-full bg-refused-bg px-2 py-0.5 text-[11px] font-semibold text-refused-fg">
                  Refused
                </span>
              </a>
            ))}
          </div>
        </div>
        <p className="mt-6 text-center text-[13px] text-muted">
          Paid rows are live from the test registry. Refusal rows are the recorded run of{' '}
          {RECORDED_DATE} — {RECORDED_REFUSALS.length} refusals, each with its chain code.
        </p>
      </div>
      <Reveal className="mt-10 text-center">
        <Link to="/dashboard" className="btn-ember">
          Open the full dashboard →
        </Link>
      </Reveal>
    </section>
  )
}

/** Step 01 visual: the real payables list; one row highlights for 1.2 s, cycling, only while in view. */
function StepVisual01({ tall = false }: { tall?: boolean }) {
  void tall
  const invoices = useInvoices()
  const slow = useSlowLoad(invoices.isLoading)
  const reduceMotion = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.4 })
  const [hi, setHi] = useState(0)
  const items = invoices.data ?? []
  useEffect(() => {
    if (!inView || reduceMotion || items.length === 0) return
    const t = setInterval(() => setHi((h) => (h + 1) % items.length), 1200)
    return () => clearInterval(t)
  }, [inView, reduceMotion, items.length])
  return (
    <div ref={ref} className="relative h-[132px] overflow-hidden rounded-[6px] border border-line">
      <Terrain src="/assets/step-sunset-field.webp" position="center 20%" />
      <div className="absolute inset-0 bg-white/55" aria-hidden="true" />
      <ul className="relative">
        {items.slice(0, 3).map((inv, i) => (
          <li
            key={inv.payable_id}
            className={`flex items-center justify-between gap-2 px-3 py-2 text-[13px] transition-colors duration-500 ${
              i === hi % items.length ? 'bg-white/90 font-medium text-ink' : 'text-body'
            }`}
          >
            <span>Payable {inv.payable_id}</span>
            <span>{inv.amount_display}</span>
            <span className={inv.status === 'paid' ? 'text-verified-fg' : 'text-unpaid-fg'}>
              {inv.status === 'paid' ? 'Paid' : 'Unpaid'}
            </span>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="px-3 py-2 text-[13px] text-muted">
            {invoices.isError
              ? COPY.statsNoData
              : invoices.isLoading
                ? `Loading payables…${slow ? ' Still loading — the test API is slow right now.' : ''}`
                : 'No invoices on the test registry right now.'}
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/** Step 02 visual: 3 sources → centre tile "9 checks"; amber dots travel the wires (SMIL). */
function StepVisual02({ tall = false }: { tall?: boolean }) {
  void tall
  const config = useConfig()
  const reduceMotion = useReducedMotion()
  const sources = [
    { label: 'Invoice file', x: 8, y: 18 },
    { label: 'Registry', x: 8, y: 66, sub: config.data ? `<${config.data.registry.index},${config.data.registry.subindex}>` : undefined },
    { label: 'Agent registry', x: 8, y: 114, sub: 'CIS-8004 instance' },
  ]
  const paths = [
    'M 108 26 C 150 26, 150 62, 186 62',
    'M 108 74 C 150 74, 150 74, 186 74',
    'M 108 122 C 150 122, 150 86, 186 86',
  ]
  return (
    <div className="relative h-[132px] overflow-hidden rounded-[6px] border border-line">
      <Terrain src="/assets/step-sunset-hills.webp" position="center 40%" />
      <div className="absolute inset-0 bg-white/75" aria-hidden="true" />
      <svg viewBox="0 0 280 148" className="absolute inset-0 h-full w-full" role="img" aria-label="Three sources — invoice file, registry, agent registry — feed the 9 checks">
        {paths.map((d) => (
          <path key={d} d={d} fill="none" stroke="#B4430F" strokeWidth="1.5" opacity="0.55" />
        ))}
        {reduceMotion
          ? paths.map((d, i) => <circle key={d} r="3" fill="#F2B872" cx={150} cy={[26, 74, 122][i]} />)
          : paths.map((d) => (
              <circle key={d} r="3.5" fill="#F2B872">
                <animateMotion dur="2.4s" repeatCount="indefinite" path={d} />
              </circle>
            ))}
        {sources.map((s) => (
          <g key={s.label}>
            <rect x={s.x} y={s.y - 10} width="100" height="22" rx="4" fill="#FFFFFF" stroke="#E7DDCB" />
            <text x={s.x + 8} y={s.y + 4} fontSize="10" fill="#171310" fontFamily="Inter, system-ui, sans-serif">
              {s.label}
            </text>
          </g>
        ))}
        <rect x="186" y="52" width="86" height="44" rx="6" fill="#171310" />
        <text x="229" y="70" fontSize="12" fill="#FFFFFF" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">
          9 checks
        </text>
        <text x="229" y="86" fontSize="9" fill="#FDBA74" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">
          before Pay
        </text>
      </svg>
    </div>
  )
}

/** Step 03 visual: the two rails, with links to the real paid examples. */
function StepVisual03({ tall = false }: { tall?: boolean }) {
  const invoices = useInvoices()
  const items = invoices.data ?? []
  const ccd = items.find((i) => i.status === 'paid' && i.asset === 'ccd')
  const eudemo = items.find((i) => i.status === 'paid' && i.asset === 'eudemo')
  return (
    <div
      className={`relative overflow-hidden rounded-[6px] border border-line ${
        tall ? 'h-full min-h-[280px]' : 'h-[132px]'
      }`}
    >
      <Terrain src="/assets/step-sunset-grass.webp" position="center 80%" />
      <div className="absolute inset-0 bg-white/55" aria-hidden="true" />
      {/* Tall mode fills the panel: the rail boxes stretch to the full
          height (flex, not a content-height grid row) and pin their live
          counts + receipt link to the bottom, so no empty grass sits below
          them (N4). */}
      <div className="relative flex h-full gap-2 p-2">
        <div className="flex flex-1 flex-col rounded-[4px] bg-white/90 p-2.5 pb-2">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-brand-700 uppercase">Rail A · CCD</p>
          <p className="mt-1 text-[13px] leading-snug text-body">One transaction. The contract is the payment.</p>
          <div className="mt-auto pt-3">
            {items.length > 0 ? (
              <p className="text-xs text-muted">
                {items.filter((i) => i.asset === 'ccd').length} payable
                {items.filter((i) => i.asset === 'ccd').length === 1 ? '' : 's'} ·{' '}
                {items.filter((i) => i.asset === 'ccd' && i.status === 'paid').length} paid once
              </p>
            ) : null}
            {ccd ? (
              <Link to={`/receipt/${ccd.payable_id}?seller=${ccd.seller}`} className="mt-1 inline-block text-xs font-medium text-brand-700">
                Payable {ccd.payable_id} · {ccd.amount_display}&nbsp;→
              </Link>
            ) : null}
          </div>
        </div>
        <div className="flex flex-1 flex-col rounded-[4px] bg-white/90 p-2.5 pb-2">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-brand-700 uppercase">Rail B · EUDemo</p>
          <p className="mt-1 text-[13px] leading-snug text-body">Reserve, co-sign, confirm. Testnet demo token.</p>
          <div className="mt-auto pt-3">
            {items.length > 0 ? (
              <p className="text-xs text-muted">
                {items.filter((i) => i.asset === 'eudemo').length} payable
                {items.filter((i) => i.asset === 'eudemo').length === 1 ? '' : 's'} ·{' '}
                {items.filter((i) => i.asset === 'eudemo' && i.status === 'paid').length} paid once
              </p>
            ) : null}
            {eudemo ? (
              <Link to={`/receipt/${eudemo.payable_id}?seller=${eudemo.seller}`} className="mt-1 inline-block text-xs font-medium text-brand-700">
                Payable {eudemo.payable_id} · {eudemo.amount_display}&nbsp;→
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Receipt checker — 5 stages from a real after-pay verify call (design §5.6).
    Fix-back-6 B9/B12 — the state must be stable and truthful:
    · the effect keys on the latest-paid ID (a number), not the invoice
      object — the old object dep re-fired the verify on EVERY 30 s poll
      (a new list object each time), resetting the verdict to "Checking…"
      and, on any flaky re-fetch, replacing it with the generic error;
    · the last good result is KEPT per payable id: a failed re-check shows
      "could not re-check — showing the last verified result", never a
      generic error in place of a verdict;
    · a "blocked" verdict whose only fails are the missing reservation /
      confirm evidence rows (live Payable 1049) gets the evidence-gap
      explanation — the payment is paid on chain; this host cannot certify
      the reservation ordering because the records are not on this host. */
function ReceiptChecker() {
  const invoices = useInvoices()
  const reduceMotion = useReducedMotion()
  const target = latestPaidInvoice(invoices.data ?? [])
  const targetId = target?.payable_id ?? null
  // Last good verify result, keyed by payable id. A re-check that fails
  // never clears it — the page keeps showing the last verified verdict.
  const [kept, setKept] = useState<{ id: number; result: VerifyResponse; at: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(0)
  const [run, setRun] = useState(0)
  const keptForTarget = kept && targetId !== null && kept.id === targetId ? kept : null
  // Same Still-loading suffix as the sibling loaders (fix-back-2 minor):
  // a checker still verifying after 15 s says so instead of spinning
  // silently. Active only while a target exists and no result/error yet.
  const checkSlow = useSlowLoad(!keptForTarget && !error && !!target)

  // Fetch as soon as a paid invoice exists (read-only verify). The old
  // inView gate never fired when the page was jumped to the bottom before
  // layout settled, so the checker stayed empty.
  useEffect(() => {
    if (targetId === null) return
    let cancelled = false
    setError(null)
    api
      .verify(targetId, 'after_pay')
      .then((r) => {
        if (cancelled) return
        setKept({ id: targetId, result: r, at: new Date().toISOString() })
        setError(null)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'The verifier did not answer.')
      })
    return () => {
      cancelled = true
    }
  }, [targetId, run])

  // Staged reveal, replayed whenever a fresh result lands for this target
  // (including Replay). Reduced motion shows all 5 stages at once.
  useEffect(() => {
    if (!keptForTarget) return
    if (reduceMotion) {
      setShown(5)
      return
    }
    setShown(0)
    const timers = [1, 2, 3, 4, 5].map((i) => setTimeout(() => setShown(i), i * 900))
    return () => timers.forEach((t) => clearTimeout(t))
  }, [keptForTarget, reduceMotion])

  const result = keptForTarget?.result ?? null
  const check = (id: string) => result?.checks.find((c) => c.id === id)
  const doc = check('doc')
  // The after-pay verifier names the paid-status check 'status_paid' on the
  // live API (before-pay calls it 'status'). Either shape must render its
  // detail — looking up 'status' alone showed a bare "—" (N2).
  const status = check('status') ?? check('status_paid')
  // A result only exists for a target (the effect returns early without
  // one), so `result && targetId` narrows targetId for the stages below.
  const stages: Array<{ label: string; detail: string }> = result && targetId !== null
    ? [
        { label: 'Fetch payable', detail: check('registered')?.detail ?? '—' },
        {
          label:
            doc?.status === 'ok'
              ? 'Hash matches'
              : doc?.status === 'fail'
                ? 'Hash does not match'
                : 'Hash: not run',
          detail: doc?.detail ?? '—',
        },
        { label: 'Seller agent active on the official registry', detail: check('agent')?.detail ?? '—' },
        {
          label: result.verdict === 'paid' ? 'Paid once: yes' : (status?.label ?? 'Status'),
          // Paid verdicts always carry a detail: the check's own, or the
          // verdict restated — never a bare "—" after the label (N2).
          detail:
            status?.detail ??
            (result.verdict === 'paid' ? `Payable ${targetId} is Paid on chain.` : '—'),
        },
        {
          label: 'Verdict',
          // No "Verdict:" prefix here — the label already says Verdict, so
          // the old text read "Verdict: Verdict: paid …" (N2).
          detail: `${result.verdict}${result.blocked_reason ? ` — ${result.blocked_reason}` : ''} (${result.passed}/${result.total} checks passed).`,
        },
      ]
    : []
  const gap = result ? evidenceGap(result) : null

  return (
    <div>
      <p className="text-[13px] tracking-[0.02em] text-muted">Receipt checker</p>
      {!target ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">
          {invoices.isError
            ? COPY.statsNoData
            : invoices.isLoading
              ? 'Loading payables…'
              : (
                <>
                  No paid invoice yet —{' '}
                  <Link to="/dashboard/pay?tab=pick" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                    pay one on the dashboard
                  </Link>{' '}
                  and the checker runs here.
                </>
              )}
        </p>
      ) : error && !keptForTarget ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">{error}</p>
      ) : !result ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">
          Checking payable {targetId} against the chain…
          {checkSlow ? ' Still loading — the test API is slow right now.' : null}
        </p>
      ) : (
        <>
          <ol className="mt-6 space-y-2.5">
            {stages.slice(0, shown).map((s, i) => (
              <li key={s.label} className="flex items-start gap-2 text-[14px] leading-snug">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
                <span>
                  <span className="font-medium text-ink">{s.label}.</span>{' '}
                  <span className="text-body">{s.detail}</span>
                  {i === 4 ? (
                    <span className="ml-1 rounded-full bg-verified-bg px-2 py-0.5 text-[11px] font-semibold text-verified-fg">
                      {result.verdict === 'paid' ? 'Verified — paid once' : `Verdict: ${result.verdict}`}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
            {shown < 5 ? (
              <li className="pl-6 text-[13px] text-muted">Stage {shown + 1} of 5…</li>
            ) : null}
          </ol>
          {gap ? (
            <p className="mt-4 rounded-md border border-line bg-paper p-4 text-[14px] leading-relaxed text-body">
              {gap}
            </p>
          ) : null}
          {error && keptForTarget ? (
            <p className="mt-3 text-[13px] text-muted">
              Could not re-check just now — showing the last verified result from{' '}
              {formatUtcTime(keptForTarget.at)} UTC.
            </p>
          ) : null}
        </>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="btn-glass !min-h-[44px] !px-5 !py-2 !text-[14px]"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" /> Replay
        </button>
        {target ? (
          <Link to={`/receipt/${target.payable_id}?seller=${target.seller}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700">
            Open the full receipt <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  )
}

export function HowItWorks() {
  const reduceMotion = useReducedMotion()
  const invoices = useInvoices()
  const config = useConfig()
  const slow = useSlowLoad(invoices.isLoading)
  const items = invoices.data ?? []
  const latestPaid = latestPaidInvoice(items)
  // F-1 (round-2 fix-back): thread the seller through — seller 2's
  // payables share ids with seller 1's, so a seller-less receipt fetch
  // would resolve to seller 1's same-id receipt (or "Not paid yet").
  const latestReceipt = useReceipt(latestPaid ? latestPaid.payable_id : null, latestPaid?.seller)
  const visuals = [StepVisual01, StepVisual02, StepVisual03]

  // Pinned scroll story (SKILL.md §3 #3, Identity Brief §3): a 300vh
  // track with a sticky pin — the four steps advance on the left while
  // the live preview for the active step holds on the right, with a
  // scaleY progress bar on the track. Below the desktop breakpoint the
  // track collapses to normal flow and the pin is static (index.css);
  // every step is a button, so on a phone the preview switches by tap.
  // All four preview panels stay mounted — the step-01 visual and the
  // step-04 receipt card keep their loading states (FIX-4), and the
  // checker rule still keys on the highest-id paid payable (FIX-7f).
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const [step, setStep] = useState(0)
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    // jsdom (and a zero-height layout) can report a non-finite progress;
    // never let it clear the active step.
    if (!Number.isFinite(p)) return
    setStep(Math.min(3, Math.floor(p * 4.0001)))
  })
  const bar = useTransform(scrollYProgress, [0, 1], [0, 1])
  const goToStep = (i: number) => {
    setStep(i)
    const el = ref.current
    if (!el || reduceMotion) return
    if (typeof window.matchMedia !== 'function') return
    if (!window.matchMedia('(min-width: 1024px)').matches) return
    const rect = el.getBoundingClientRect()
    const top = rect.top + window.scrollY
    const scrollable = Math.max(0, rect.height - window.innerHeight)
    window.scrollTo({ top: top + ((i + 0.5) / 4) * scrollable, behavior: 'auto' })
  }

  return (
    <section ref={ref} id="how" aria-labelledby="how-title" className="po-story mx-auto max-w-[1101px] scroll-mt-4 px-4 pb-[114px] sm:px-6">
      <div className="po-story__pin">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-14">
          <div>
            <Reveal>
              <p className="text-sm font-medium tracking-[0.02em] text-ink">
                <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
                How it works
              </p>
              <h2 id="how-title" className="mt-6 max-w-[480px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
                From invoice to verified receipt in four steps.
              </h2>
              <p className="mt-6 max-w-[320px] text-[15px] leading-[1.5] text-muted">
                A judge can run the whole flow on the dashboard in about a minute, with no wallet and no sign-in.
              </p>
            </Reveal>
            <div className="po-story__track mt-10 border-l border-line pl-6">
              <motion.div className="po-story__bar" style={{ scaleY: bar }} aria-hidden="true" />
              {STEPS.map((s, i) => (
                <div key={s.n} className={`po-story__step py-5 ${i === step ? 'is-on' : ''}`}>
                  <button
                    type="button"
                    onClick={() => goToStep(i)}
                    aria-current={i === step ? 'step' : undefined}
                    className="block w-full cursor-pointer rounded-[6px] text-left focus-visible:outline-2 focus-visible:outline-brand-600"
                  >
                    <span className="text-[13px] tracking-[0.02em] text-muted">{s.n}</span>
                    <span role="heading" aria-level={3} className="mt-4 block text-[30px] leading-[1.13] font-normal tracking-[-0.02em] text-ink">
                      {s.title}
                    </span>
                  </button>
                  <p className="mt-3 max-w-[42ch] text-[15px] leading-[1.5] text-muted">{s.body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Sticky preview: one panel per step, stacked in a single grid
              cell; only the active panel is visible. Panels 1–3 are the
              step visuals; panel 4 is the receipt — the latest real
              payment over the dawn terrain, with its receipt link. */}
          <div className="po-story__panels" aria-live="off">
            {STEPS.slice(0, 3).map((s, i) => {
              const Visual = visuals[i]
              return (
                <div key={s.n} className={`po-story__panel ${i === step ? 'is-on' : ''}`}>
                  <div className="rounded-[6px] border border-line bg-card p-6">
                    <p className="text-[13px] tracking-[0.02em] text-muted">
                      Step {s.n} — {s.title}
                    </p>
                    <div className="mt-5">
                      <Visual tall={i === 2} />
                    </div>
                    <p className="mt-5 text-[15px] leading-[1.5] text-muted">
                      {i === 0
                        ? 'Live payables from the test registry — one row highlights at a time.'
                        : i === 1
                          ? 'Three sources feed the 9 checks. Nothing is paid until they pass.'
                          : 'Two rails, never mixed: CCD on Rail A, the EUDemo test token on Rail B.'}
                    </p>
                  </div>
                </div>
              )
            })}
            <div className={`po-story__panel ${3 === step ? 'is-on' : ''}`}>
              <div className="relative overflow-hidden rounded-[6px] border border-line bg-card p-6">
                <div className="absolute inset-0" aria-hidden="true">
                  <Terrain src="/assets/wide-wheat.webp" position="center 60%" />
                  <div className="absolute inset-0 bg-white/60" />
                </div>
                <div className="relative">
                  <p className="text-[13px] tracking-[0.02em] text-muted">Step 04 — Receipt</p>
                  <p className="mt-5 max-w-[52ch] text-[15px] leading-[1.5] text-muted">{STEPS[3].body}</p>
                  <div className="mt-6 flex flex-wrap gap-4">
                    <Link to="/dashboard/pay?tab=pick" className="btn-ember !min-h-[44px]">
                      Open the payment list
                    </Link>
                    <Link to="/judges" className="btn-glass !min-h-[44px]">
                      Verify a receipt
                    </Link>
                  </div>
                  <div className="mt-5 max-w-[420px] rounded-md border border-line bg-card p-4 shadow-[0_8px_24px_rgba(11,31,36,0.08)]">
                    {latestPaid ? (
                      <div className="text-sm">
                        <p className="font-medium text-ink">
                          Latest payment — Payable {latestPaid.payable_id} · {latestPaid.amount_display}
                        </p>
                        <p className="mt-1 text-muted">
                          Due {formatUtcDateTime(latestPaid.due)} · {COPY.labInvoiceLabel}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <Link to={`/receipt/${latestPaid.payable_id}?seller=${latestPaid.seller}`} className="inline-flex items-center gap-1 font-medium text-brand-700">
                            Confirm receipt <ArrowRight className="h-4 w-4" aria-hidden="true" />
                          </Link>
                          {latestReceipt.data?.txs[0] ? (
                            <a
                              href={latestReceipt.data.txs[0].explorer_url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-xs text-brand-700"
                            >
                              {latestReceipt.data.txs[0].tx_hash.slice(0, 8)}…{latestReceipt.data.txs[0].tx_hash.slice(-6)} ↗
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ) : invoices.isLoading ? (
                      <p className="text-sm text-muted">
                        {`Loading payables…${slow ? ' Still loading — the test API is slow right now.' : ''}`}
                      </p>
                    ) : (
                      <p className="text-sm text-muted">
                        {invoices.isError ? (
                          COPY.statsNoData
                        ) : (
                          <>
                            No paid invoice yet.{' '}
                            <Link to="/dashboard/pay?tab=pick" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                              Pay one on the dashboard
                            </Link>{' '}
                            and it appears here.
                          </>
                        )}
                      </p>
                    )}
                    {config.data ? (
                      <p className="mt-3 font-mono text-xs text-muted">
                        Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt;
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** Receipt verifier — its own full-width section (polished sketch), with
    the same live 5-stage verify as before. */
export function VerifierSection() {
  return (
    <section aria-labelledby="verifier-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal className="text-center">
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Receipt verifier
        </p>
        <h2 id="verifier-title" className="mx-auto mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Upload a receipt. Check it against the chain.
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          Every payment is re-read from the chain — document hash, seller agent, paid-once status — before the
          verdict. Nothing here is a screenshot.
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <div className="card-glass mx-auto mt-14 max-w-[720px] p-8 sm:p-10">
          <ReceiptChecker />
        </div>
      </Reveal>
    </section>
  )
}

/** Spec Matrix — the hard bounds in one hairline table (SKILL.md §3 #8).
    Every row is tagged LIVE (read from /api/config on this visit) or
    RECORDED (the 24 Nov 2026 run, labelled with its date). The contract
    declares 27 reject codes (README.md:32; contracts/CONTRACT_REPORT.md:38),
    but only 7 refusals were observed in the recorded run, so the table
    states the 7 recorded refusals instead — never an unverified count. */
export function SpecMatrix() {
  const config = useConfig()
  const c = config.data
  const rows: Array<{ name: string; value: string; tag: 'LIVE' | 'RECORDED'; tagNote: string; label: string }> = [
    {
      name: 'Reservation',
      value: c ? `${c.reservation_secs} s${c.reservation_secs % 60 === 0 ? ` (${c.reservation_secs / 60} minutes)` : ''} — the payable is reserved for one payer` : config.isError ? 'Could not load — the test API did not answer.' : 'Loading…',
      tag: 'LIVE',
      tagNote: 'From /api/config',
      label: 'Live',
    },
    {
      name: 'Co-signer margin',
      value: c ? `${c.co_signer_margin_secs} s` : config.isError ? 'Could not load — the test API did not answer.' : 'Loading…',
      tag: 'LIVE',
      tagNote: 'From /api/config',
      label: 'Live',
    },
    {
      name: 'Fee peg',
      value: '€0.01 per transaction on Concordium',
      tag: 'RECORDED',
      tagNote: 'Glossary entry “Fee peg”',
      label: 'Recorded · glossary',
    },
    {
      name: 'Checks before Pay',
      value: '9 checks run against the chain — document hash, agent token and unpaid status — before Pay is enabled',
      tag: 'RECORDED',
      tagNote: 'The check step on the dashboard',
      label: 'Recorded · check step',
    },
    {
      name: 'Recorded refusals',
      value: `${RECORDED_REFUSALS.length} refusals in the recorded run, each with its chain code`,
      tag: 'RECORDED',
      tagNote: `Recorded run, ${RECORDED_DATE}`,
      label: `Recorded · ${RECORDED_DATE}`,
    },
    {
      name: 'Successful CCD payment fee',
      value: '16.2 testnet CCD in the recorded run — more than the 0.5 CCD invoice. Fees vary per transaction.',
      tag: 'RECORDED',
      tagNote: `Recorded run, ${RECORDED_DATE}`,
      label: `Recorded · ${RECORDED_DATE}`,
    },
    {
      name: 'Registry',
      value: c ? `<${c.registry.index},${c.registry.subindex}>` : config.isError ? 'Could not load — the test API did not answer.' : 'Loading…',
      tag: 'LIVE',
      tagNote: 'From /api/config',
      label: 'Live',
    },
    {
      name: 'Sellers',
      value: c?.sellers
        ? `${c.sellers.length} sellers on the test registry — agent tokens ${c.sellers.map((s) => s.agent_token).join(', ')}`
        : config.isError
          ? 'Could not load — the test API did not answer.'
          : 'Loading…',
      tag: 'LIVE',
      tagNote: 'From /api/config',
      label: 'Live',
    },
  ]
  return (
    <section aria-labelledby="spec-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal>
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          The bounds
        </p>
        <h2 id="spec-title" className="mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          The numbers the chain holds us to.
        </h2>
        <p className="mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          No checkmark clutter, no ranges without a source. Live rows are read from the test registry on this visit;
          recorded rows name their source in the table.
        </p>
      </Reveal>
      <Reveal delay={0.08}>
        <div className="mt-14 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[13px] text-muted">
                <th scope="col" className="py-3 pr-4 font-medium">Bound</th>
                <th scope="col" className="py-3 pr-4 font-medium">Value</th>
                <th scope="col" className="py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-b border-line align-top">
                  <th scope="row" className="py-4 pr-4 text-[15px] font-medium whitespace-nowrap text-ink">{r.name}</th>
                  <td className="py-4 pr-4 text-[15px] leading-[1.6] text-body">{r.value}</td>
                  <td className="py-4 whitespace-nowrap">
                    <span
                      title={r.tagNote}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        r.tag === 'LIVE' ? 'bg-verified-bg text-verified-fg' : 'bg-paper-2 text-body'
                      }`}
                    >
                      {r.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  )
}

/** The AI planner — the REAL NEAR AI planner, not a demo conversation.
    A real language-model loop on NEAR AI Cloud (model z-ai/glm-5.3-flash)
    that acts ONLY through four tools. It never invents a payee, an amount
    or a transaction hash: the chain decides those, and a tool refusal stops
    the run. The live injection test passed with 0 dispatches (a document
    that told it to pay a different account was ignored). The reliability
    gate is in independent judgment — this page claims nothing about it. */
const PLANNER_TOOLS = [
  {
    name: 'verify_invoice',
    body: 'Verify a payment against a payable on the test registry — runs the verifier live from chain state and returns the full check list.',
  },
  {
    name: 'pay_payable',
    body: 'Pay a payable for real. Validates everything first and refuses without sending on any failure. Takes no payee and no amount — both come from the on-chain payable view.',
  },
  {
    name: 'receipt',
    body: 'Receipt facts re-read live from the chain: the payable row, the transaction hashes, the block times, and a fresh verifier re-run.',
  },
  {
    name: 'list_payables',
    body: 'Payable rows read live from the test registry: id, status, amount, asset, payee, due. Unregistered ids are reported as absent.',
  },
]

export function PlannerSection() {
  return (
    <section aria-labelledby="planner-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      {/* Asymmetric two-column composition — deliberately NOT another
          4-column hairline grid (Features already holds that anchor).
          Left: the claim, sticky in place. Right: the four tools as
          hairline-divided rows, one per line, mono names first. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-14">
        <Reveal>
          <p className="text-sm font-medium tracking-[0.02em] text-ink">
            <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
            The planner
          </p>
          <h2 id="planner-title" className="mt-6 max-w-[480px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
            An agent that plans the payment — and nothing else.
          </h2>
          <p className="mt-6 max-w-[480px] text-[17px] leading-[1.6] text-muted">
            A real language-model loop on NEAR AI Cloud (model z-ai/glm-5.3-flash) that acts only through four tools.
            The model talks; the chain decides.
          </p>
          <p className="mt-8 max-w-[480px] text-[15px] leading-[1.6] text-muted">
            The planner never invents a payee, an amount or a transaction hash. If a tool refuses, it stops — it does
            not retry with different arguments. A document that told it to pay a different account was ignored in the
            live injection test: 0 dispatches. The reliability gate is in independent judgment; this page claims
            nothing about it.
          </p>
        </Reveal>
        <div>
          {PLANNER_TOOLS.map((t, i) => (
            <Reveal key={t.name} delay={i * 0.06}>
              <div className="border-t border-line py-6 first:border-t-0 first:pt-0 lg:first:pt-6">
                <p className="font-mono text-[14px] font-semibold text-brand-700">{t.name}</p>
                <p className="mt-2 max-w-[52ch] text-[15px] leading-[1.6] text-muted">{t.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/** For judges — the three live checks a judge can open in about a minute:
    the verification spec, the real dashboard, and the age proof. No wallet,
    no sign-in, no real money: testnet only. */
const JUDGE_LINKS = [
  {
    to: '/judges',
    title: 'Verification spec',
    body: 'The contract, the checks, the sample transactions and the limits — what was proven, and what was not.',
  },
  {
    to: '/dashboard',
    title: 'Live dashboard',
    body: 'The real numbers, live from the test registry: payables, paid once, refused on chain.',
  },
  {
    to: '/verify-age',
    title: 'Prove 18+',
    body: 'Age proof with a zero-knowledge presentation — the birthday never leaves the holder.',
  },
]

export function JudgesSection() {
  return (
    <section aria-labelledby="judges-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      {/* Hairline rows, not glass cards: the verifier section already
          holds the landing's one glass surface, and a second 3-card glass
          row would repeat that anchor. One row per check, whole row a link. */}
      <Reveal>
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          For judges
        </p>
        <h2 id="judges-title" className="mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Verify everything yourself, in about a minute.
        </h2>
        <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-muted">
          No wallet, no sign-in, no real money. Testnet only — every link below is a live check, not a screenshot.
        </p>
      </Reveal>
      <div className="mt-14 border-t border-line">
        {JUDGE_LINKS.map((c, i) => (
          <Reveal key={c.to} delay={i * 0.06}>
            <Link
              to={c.to}
              className="group flex min-h-[88px] items-center gap-6 border-b border-line py-6 transition-colors hover:bg-card"
            >
              <span className="w-10 shrink-0 text-[13px] text-muted tabular-nums">0{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[22px] leading-tight font-medium tracking-[-0.01em] text-ink">{c.title}</span>
                <span className="mt-1 block max-w-[64ch] text-[15px] leading-[1.6] text-muted">{c.body}</span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-[15px] font-medium text-brand-700 transition-transform duration-200 group-hover:translate-x-1">
                Open →
              </span>
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

/** FAQ — the questions a sceptical reviewer asks before trusting a
    payment (SKILL.md §3 #9). Single-column accordion; every answer is
    grounded in the chain, the recorded run, or the live config — no new
    claims, no invented guarantees. */
const FAQ_ITEMS = [
  {
    q: 'What happens if I pay the same invoice twice?',
    a: 'The contract refuses the second payment before any money moves, and the refusal itself is on chain with its code. The recorded run has 7 refusals in total, including one for a second payment, each linked from the proof wall above.',
  },
  {
    q: 'Where does the money actually go?',
    a: 'The payee is read from the chain, never from the document. A payment can only go to the account the seller put on the registry — the document is evidence, not the instruction.',
  },
  {
    q: 'What does a payment cost?',
    a: 'Concordium pegs the fee at €0.01 per transaction. In the recorded run a successful CCD payment cost 16.2 testnet CCD — more than the 0.5 CCD invoice — and fees vary per transaction. These are testnet fees, not mainnet estimates.',
  },
  {
    q: 'How do I know the seller is who they claim to be?',
    a: 'Each seller has an agent token on the official CIS-8004 registry, and the badge check on the dashboard is live. What is not verified: no company (LEI) or identity proof is attached to either seller.',
  },
  {
    q: 'Is this real money?',
    a: 'No. Testnet only — CCD on the Concordium testnet and EUDemo, a testnet demo token. No real money moves here, and the receipt says so: it is not a legal invoice, a tax document or proof of delivery.',
  },
  {
    q: 'What if the test API is down when I open the page?',
    a: 'The dashboard keeps showing the last verified numbers and says so, with the time they were last refreshed. A receipt is re-verified from the chain on each visit instead of trusting a stored copy — but the receipt page itself loads through the API, so it cannot open while the API is down. Only the on-chain record and the downloadable verifier are API-independent.',
  },
  {
    q: 'What if a payment is refused?',
    a: 'Nothing moves. A chain refusal carries its code and a plain-English reason; a co-signer refusal happens before signing, so no transaction is sent. The chain still charges a fee for a refused transaction — the recorded run lists those fees.',
  },
]

export function FaqSection() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section aria-labelledby="faq-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal>
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Asked before you ask
        </p>
        <h2 id="faq-title" className="mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          The sceptical questions, answered plainly.
        </h2>
      </Reveal>
      <div className="mx-auto mt-14 max-w-[720px] border-t border-line">
        {FAQ_ITEMS.map((item, i) => {
          const isOpen = open === i
          return (
            <div key={item.q} className="border-b border-line">
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${i}`}
                  id={`faq-button-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="po-faq__btn flex items-center justify-between gap-4 py-5 text-left text-[17px] font-medium text-ink"
                >
                  <span>{item.q}</span>
                  <span aria-hidden="true" className="shrink-0 text-[20px] leading-none text-muted">
                    {isOpen ? '−' : '+'}
                  </span>
                </button>
              </h3>
              <div
                id={`faq-panel-${i}`}
                role="region"
                aria-labelledby={`faq-button-${i}`}
                hidden={!isOpen}
                className="pb-6"
              >
                <p className="max-w-[64ch] text-[15px] leading-[1.6] text-muted">{item.a}</p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Hairline figures — three figures in the hairline style, one isometric
    line drawing each, answering the pointer. Press play on any of them, or
    just move your pointer over the drawing. */
const FIGURES = [
  {
    name: 'payable',
    caption: 'A payable on its tray. Move the pointer over a sheet to lift it; press it to pay — the receipt slip rises behind it.',
  },
  {
    name: 'seal',
    caption: 'The paid-once seal. Press it and it stamps down — one payable, one stamp, one payment.',
  },
  {
    name: 'receipt',
    caption: 'A receipt printing from its slot. Move the pointer along it to print more; every line is a line of the proof.',
  },
]

export function HairlineFigures() {
  return (
    <section aria-labelledby="figures-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal className="text-center">
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Drawn in hairline
        </p>
        <h2 id="figures-title" className="mx-auto mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Pay once, drawn in one line.
        </h2>
        <p className="mx-auto mt-5 max-w-[640px] text-[17px] leading-[1.6] text-muted">
          Three figures in the hairline style — one isometric line drawing each, answering the pointer. Press play on any
          of them, or just move your pointer over the drawing.
        </p>
      </Reveal>
      <div className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-3 md:gap-6">
        {FIGURES.map((f, i) => (
          <Reveal key={f.name} delay={i * 0.08}>
            <HairlineFigure name={f.name} caption={f.caption} />
          </Reveal>
        ))}
      </div>
    </section>
  )
}

export function CtaBand() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-t border-white/20 bg-sky-0">
      <div className="relative mx-auto flex max-w-[1101px] flex-wrap items-center justify-between gap-8 px-4 py-20 sm:px-6">
        <h2 id="cta-title" className="max-w-[520px] text-[36px] leading-[1.1] font-medium tracking-[-0.02em] text-white">
          Verify your first invoice in about a minute.
        </h2>
        <div className="flex flex-wrap gap-4">
          <Link to="/dashboard/pay?tab=pick" className="btn-glass">
            Verify an invoice
          </Link>
          <Link to="/dashboard" className="btn-ghost-light">
            Open the dashboard
          </Link>
        </div>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-paper">
      <div className="mx-auto grid max-w-[1101px] grid-cols-2 gap-10 px-4 py-14 sm:px-6 md:grid-cols-4">
        <div>
          <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home">
            <Logo size={24} />
          </Link>
          <p className="mt-4 max-w-[240px] text-sm leading-relaxed text-muted">
            Payments, settled. Every invoice paid once. Every payment provable.
          </p>
          <p className="mt-4 text-sm text-muted">{COPY.footer}</p>
        </div>
        <nav aria-label="Product">
          <p className="text-sm font-semibold text-ink">Product</p>
          <ul className="mt-4 space-y-3 text-sm text-muted">
            <li>
              <Link to="/dashboard/pay?tab=pick" className="hover:text-ink">Pay an invoice</Link>
            </li>
            <li>
              <Link to="/dashboard" className="hover:text-ink">Dashboard</Link>
            </li>
            <li>
              <Link to="/judges" className="hover:text-ink">For judges</Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Resources">
          <p className="text-sm font-semibold text-ink">Resources</p>
          <ul className="mt-4 space-y-3 text-sm text-muted">
            <li>
              <a href={EXPLORER_HOME} target="_blank" rel="noreferrer" className="hover:text-ink">
                Explorer (testnet)
              </a>
            </li>
            <li>
              <Link to="/judges" className="hover:text-ink">Verification spec</Link>
            </li>
            <li>
              <Link to="/" className="hover:text-ink">Home</Link>
            </li>
          </ul>
        </nav>
        <div>
          <p className="text-sm font-semibold text-ink">Network</p>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Testnet only. Concordium testnet. No real money moves here.
          </p>
        </div>
      </div>
    </footer>
  )
}
