// Landing sections below the flow — P2 §4.2 section mapping + design §3/§5.
// Features: 4-column card row with shared hairlines + corner handle squares
// (design §2: 5px ink squares on every outer corner via .handles + <i>).
// How it works: 3 step cards, each with a visual slot over the dawn-terrain
// image (design §5): 01 payables list with a cycling highlighted row (1.2 s,
// only while in view), 02 connector diagram (3 sources → 9 checks, amber
// dots travel the wires), 03 the two payment rails. Card 04: floating
// notification over terrain with the latest real payment. Receipt checker:
// 5 stages from a real after-pay verify call, 0.9 s apart, replay button.
import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bug, CheckCircle2, Receipt, RotateCcw, ShieldCheck, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useConfig, useInvoices, useReceipt, useStats } from '../hooks/useApi'
import { api } from '../lib/api'
import { COPY } from '../lib/copy'
import { derivedStatus } from '../lib/dashboard'
import { formatUtcDateTime } from '../lib/format'
import { EXPLORER_HOME } from '../lib/tokens'
import { CountUp, InvoiceStatusPill, Reveal } from './polish'
import { Logo } from './Logo'
import type { VerifyResponse } from '../lib/types'

const FEATURES = [
  {
    icon: Wallet,
    title: 'Pay once',
    body: 'The contract refuses a second payment, a wrong amount, or a changed payee.',
  },
  {
    icon: ShieldCheck,
    title: 'Verify before you pay',
    body: 'Check the document hash, the seller’s agent token and the unpaid status before Pay is enabled.',
  },
  {
    icon: Bug,
    title: 'Try to break it',
    body: 'Send a wrong amount, a tampered file or a second payment, and watch each one stop.',
  },
  {
    icon: Receipt,
    title: 'Receipts you can re-verify',
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
          Four checks before a single cent moves.
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          The payee is read from the chain, never from the document. The document is evidence, not the instruction.
        </p>
      </Reveal>
      <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.08}>
            <div className="card-glass flex min-h-[248px] flex-col justify-between p-8 transition-transform duration-200 hover:-translate-y-1.5">
              <span
                className="flex h-12 w-12 items-center justify-center rounded-full text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_8px_16px_rgba(154,52,18,0.4)]"
                style={{ background: 'linear-gradient(180deg, #C2410C 0%, #9A3412 100%)' }}
              >
                <f.icon className="h-5 w-5" aria-hidden="true" />
              </span>
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

/** Live stats band — big count-up numbers, all from /api/stats + the live
    list. Sits between the console and the features, like the polished
    landing sketch's stat strip. */
export function LiveStatsBand() {
  const stats = useStats()
  const invoices = useInvoices()
  const items = invoices.data ?? []
  const s = stats.data
  const unpaid = items.filter((i) => i.status !== 'paid').length
  const cells = [
    { label: 'Payables on the registry', value: s?.payables_total ?? null },
    { label: 'Paid once', value: s?.paid_total ?? null },
    { label: 'Unpaid open', value: items.length ? unpaid : null },
    { label: 'Refused on chain', value: s?.refused_on_chain_since_deploy ?? null },
  ]
  return (
    <section aria-label="Live registry stats band" className="mx-auto max-w-[1101px] px-4 pt-4 pb-8 sm:px-6">
      <Reveal>
        <div className="card-glass grid grid-cols-2 gap-2 p-6 sm:p-8 lg:grid-cols-4">
          {cells.map((c) => (
            <div key={c.label} className="flex flex-col items-center gap-2 px-2 py-3 text-center">
              <span className="text-[44px] leading-none font-medium tracking-[-0.02em] text-brand-700 tabular-nums sm:text-[52px]">
                {c.value === null ? '—' : <CountUp value={c.value} />}
              </span>
              <span className="text-[14px] font-medium text-body">{c.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-center text-sm text-muted">
          Live from the test registry ·{' '}
          {s?.last_verifier_run_at ? `last verifier run ${formatUtcDateTime(s.last_verifier_run_at)}` : 'loading…'}
        </p>
      </Reveal>
    </section>
  )
}

/** Invoice showcase — the latest live invoices as glossy glass cards
    (polished sketch: "Beautiful, transparent invoicing"). Paid first by
    highest id, then the soonest-due unpaid ones. */
export function InvoiceShowcase() {
  const invoices = useInvoices()
  const items = invoices.data ?? []
  const paid = [...items].filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id)
  const unpaid = [...items].filter((i) => i.status !== 'paid').sort((a, b) => a.due.localeCompare(b.due))
  const shown = [...paid.slice(0, 2), ...unpaid.slice(0, 1)]
  return (
    <section aria-labelledby="showcase-title" className="mx-auto max-w-[1101px] px-4 pb-28 sm:px-6">
      <Reveal className="text-center">
        <p className="text-sm font-medium tracking-[0.02em] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
          Live from the registry
        </p>
        <h2 id="showcase-title" className="mx-auto mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
          Beautiful, transparent invoicing.
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
          Clients pay faster with clean, clear invoices that build trust. These are the real payables on the test
          registry right now.
        </p>
      </Reveal>
      <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
        {shown.length === 0 ? (
          <p className="text-[15px] text-muted md:col-span-3">
            {invoices.isError ? COPY.statsNoData : 'Loading payables…'}
          </p>
        ) : (
          shown.map((inv, i) => (
            <Reveal key={inv.payable_id} delay={i * 0.08}>
              <article className="card-glass flex min-h-[260px] flex-col p-8 transition-transform duration-200 hover:-translate-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13px] font-semibold tracking-[0.06em] text-muted uppercase">
                    Invoice #{inv.payable_id}
                  </p>
                  <InvoiceStatusPill status={derivedStatus(inv)} />
                </div>
                <p className="mt-5 text-[15px] text-body">{inv.label}</p>
                <p className="mt-2 text-[34px] leading-none font-medium tracking-[-0.02em] text-ink tabular-nums">
                  {inv.amount_display}
                </p>
                <p className="mt-3 text-sm text-muted">Due {formatUtcDateTime(inv.due)}</p>
                <p className="mt-1 text-sm text-muted">Rail {inv.asset === 'ccd' ? 'A · CCD' : 'B · EUDemo'}</p>
                <div className="mt-auto pt-8">
                  <Link to={`/receipt/${inv.payable_id}`} className="btn-glass w-full !min-h-[44px] !px-5 !py-2 !text-[14px]">
                    View receipt →
                  </Link>
                </div>
              </article>
            </Reveal>
          ))
        )}
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
          <li className="px-3 py-2 text-[13px] text-muted">Loading payables…</li>
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
      <div className="relative grid h-full grid-cols-2 gap-2 p-2">
        <div className="rounded-[4px] bg-white/90 p-2.5">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-brand-700 uppercase">Rail A · CCD</p>
          <p className="mt-1 text-[13px] leading-snug text-body">One transaction. The contract is the payment.</p>
          {ccd ? (
            <Link to={`/receipt/${ccd.payable_id}`} className="mt-1.5 inline-block text-xs font-medium text-brand-700">
              Payable {ccd.payable_id} · {ccd.amount_display} →
            </Link>
          ) : null}
        </div>
        <div className="rounded-[4px] bg-white/90 p-2.5">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-brand-700 uppercase">Rail B · EUDemo</p>
          <p className="mt-1 text-[13px] leading-snug text-body">Reserve, co-sign, confirm. Testnet demo token.</p>
          {eudemo ? (
            <Link to={`/receipt/${eudemo.payable_id}`} className="mt-1.5 inline-block text-xs font-medium text-brand-700">
              Payable {eudemo.payable_id} · {eudemo.amount_display} →
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Receipt checker — 5 stages from a real after-pay verify call (design §5.6). */
function ReceiptChecker() {
  const invoices = useInvoices()
  const reduceMotion = useReducedMotion()
  const paid = (invoices.data ?? []).filter((i) => i.status === 'paid')
  const target = paid[0]
  const [result, setResult] = useState<VerifyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(0)
  const [run, setRun] = useState(0)

  // Fetch as soon as a paid invoice exists (read-only verify). The old
  // inView gate never fired when the page was jumped to the bottom before
  // layout settled, so the checker stayed empty. The staged reveal still
  // plays as the user arrives; Replay re-runs it.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    setResult(null)
    setError(null)
    setShown(0)
    api
      .verify(target.payable_id, 'after_pay')
      .then((r) => {
        if (cancelled) return
        setResult(r)
        if (reduceMotion) {
          setShown(5)
          return
        }
        for (let i = 1; i <= 5; i++) {
          setTimeout(() => {
            if (!cancelled) setShown(i)
          }, i * 900)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'The verifier did not answer.')
      })
    return () => {
      cancelled = true
    }
  }, [target, run, reduceMotion])

  const check = (id: string) => result?.checks.find((c) => c.id === id)
  const doc = check('doc')
  const status = check('status')
  const stages: Array<{ label: string; detail: string }> = result
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
          detail: status?.detail ?? '—',
        },
        {
          label: 'Verdict',
          detail: `Verdict: ${result.verdict}${result.blocked_reason ? ` — ${result.blocked_reason}` : ''} (${result.passed}/${result.total} checks passed).`,
        },
      ]
    : []

  return (
    <div>
      <p className="text-[13px] tracking-[0.02em] text-muted">Receipt checker</p>
      {!target ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">
          {invoices.isError ? COPY.statsNoData : 'Waiting for a paid invoice to check.'}
        </p>
      ) : error ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">{error}</p>
      ) : !result ? (
        <p className="mt-8 text-[15px] leading-[1.5] text-muted">
          Checking payable {target.payable_id} against the chain…
        </p>
      ) : (
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
          <Link to={`/receipt/${target.payable_id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700">
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
  const stats = useStats()
  const config = useConfig()
  const items = invoices.data ?? []
  const paid = items.filter((i) => i.status === 'paid')
  const dueSoon = items.filter((i) => i.status !== 'paid')
  // The invoices list carries no paid_at, so the most recently created paid
  // payable (highest id) is the latest payment: ids are sequential and the
  // paid set was paid in id order (1006 paid 15:08 UTC, after 1005 13:20 UTC).
  const latestPaid = [...paid].sort((a, b) => b.payable_id - a.payable_id)[0]
  const latestReceipt = useReceipt(latestPaid ? latestPaid.payable_id : null)
  const visuals = [StepVisual01, StepVisual02, StepVisual03]

  return (
    <section id="how" aria-labelledby="how-title" className="mx-auto max-w-[1101px] scroll-mt-4 px-4 pb-[114px] sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-sm font-medium tracking-[0.02em] text-ink">
            <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
            How it works
          </p>
          <h2 id="how-title" className="mt-6 max-w-[480px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink">
            From invoice to verified receipt in three steps.
          </h2>
        </div>
        <p className="max-w-[320px] text-[15px] leading-[1.5] text-muted">
          A judge can run the whole flow in about thirty seconds, with no wallet and no sign-in.
        </p>
      </div>

      <div className="handles hairline-grid mt-12 grid grid-cols-1 border border-line bg-card md:grid-cols-3">
        <i aria-hidden="true" />
        {STEPS.map((s, i) => {
          const Visual = visuals[i]
          return (
            <motion.div
              key={s.n}
              className={`border border-line bg-card p-6 ${i === 2 ? 'flex flex-col md:row-span-2' : ''}`}
              initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.6, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="text-[13px] tracking-[0.02em] text-muted">{s.n}</p>
              <h3 className="mt-4 text-[30px] leading-[1.13] font-normal tracking-[-0.02em] text-ink">{s.title}</h3>
              <p className="mt-3 max-w-[42ch] text-[15px] leading-[1.5] text-muted">{s.body}</p>
              <div className={i === 2 ? 'mt-5 flex-1' : 'mt-5'}>
                <Visual tall={i === 2} />
              </div>
            </motion.div>
          )
        })}
        {/* Card 04 — wide bento: live verified payments over the dawn terrain. */}
        <motion.div
          className="relative overflow-hidden border border-line bg-card p-6 md:col-span-2"
          initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, delay: 0.24, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="absolute inset-0" aria-hidden="true">
            <Terrain src="/assets/wide-wheat.webp" position="center 60%" />
            <div className="absolute inset-0 bg-white/60" />
          </div>
          <div className="relative">
            <p className="text-[13px] tracking-[0.02em] text-muted">04</p>
            <h3 className="mt-8 text-[30px] leading-[1.13] font-normal tracking-[-0.02em] text-ink">
              Live verified payments
            </h3>
            <p className="mt-3 max-w-[52ch] text-[15px] leading-[1.5] text-muted">
              {stats.data
                ? `${stats.data.paid_total} payable${stats.data.paid_total === 1 ? '' : 's'} paid once, ${dueSoon.length} unpaid open right now.`
                : 'Live numbers load from the testnet.'}{' '}
              Insight lines are computed from state, not from a language model.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Link to="#invoice" className="btn-ember !min-h-[44px]">
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
                    <Link to={`/receipt/${latestPaid.payable_id}`} className="inline-flex items-center gap-1 font-medium text-brand-700">
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
              ) : (
                <p className="text-sm text-muted">
                  {invoices.isError ? COPY.statsNoData : 'No paid invoice yet. Pay one above and it appears here.'}
                </p>
              )}
              {config.data ? (
                <p className="mt-3 font-mono text-xs text-muted">
                  Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt;
                </p>
              ) : null}
            </div>
          </div>
        </motion.div>
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
          Upload a receipt. Verify in seconds.
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

export function CtaBand() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden bg-sky-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(600px 200px at 80% 0%, rgba(253,186,116,0.35), transparent 70%)' }}
      />
      <div className="relative mx-auto flex max-w-[1101px] flex-wrap items-center justify-between gap-8 px-4 py-20 sm:px-6">
        <h2 id="cta-title" className="max-w-[520px] text-[36px] leading-[1.1] font-medium tracking-[-0.02em] text-white">
          Verify your first invoice in about a minute.
        </h2>
        <div className="flex flex-wrap gap-4">
          <Link to="#invoice" className="btn-glass">
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
              <Link to="/#invoice" className="hover:text-ink">Pay an invoice</Link>
            </li>
            <li>
              <Link to="/dashboard" className="hover:text-ink">Dashboard</Link>
            </li>
            <li>
              <Link to="/#console" className="hover:text-ink">Live console</Link>
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
