// Break it: five attacks, each labelled with the layer that stops it
// (Chain, Policy gate or App) and whether the result came from a real call,
// a recorded run, or is an illustration. Nothing here prints a refusal that
// was not returned by the API or computed in your browser.
import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { sha256Hex } from '../../lib/hash'
import { truncHash } from '../../lib/format'
import { ApiError, type AttackResult, type Layer, type PayableFacts } from '../../lib/types'
import { useConfig, useHealth } from '../../hooks/useApi'
import { itemKey, type PayableKey } from '../keys'
import { recordedLabel } from '../fees'
import { useAppData, useDocumentTitle, useSellers } from '../hooks'
import { Button, ExplorerTx, IllustrationTag, KeyValue, LayerLabel, Notice, PageHeader, Skeleton, useExplorerBase } from '../ui'

type AttackId = 'tamper' | 'twice' | 'amount' | 'fraud' | 'inject'
type Source = 'real' | 'recorded' | 'illustration'

interface Outcome {
  tried: string
  layer: Layer
  source: Source
  sourceDate?: string | null
  stopped: string
  reject?: { code: number; name: string } | null
  fee?: string | null
  tx?: string | null
  note?: string
}

function SourceBadge({ source, date }: { source: Source; date?: string | null }) {
  if (source === 'illustration') return <IllustrationTag />
  if (source === 'recorded') return <span className="po-tag po-tag-recorded">{recordedLabel(date).toUpperCase()}</span>
  return <span className="po-tag po-tag-live">REAL CALL</span>
}

function OutcomeView({ o }: { o: Outcome }) {
  const explorer = useExplorerBase()
  return (
    <div className="rounded-[10px] border border-po-line bg-po-paper p-4" aria-live="polite" data-testid="attack-outcome">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-po-grey">Stopped by</span>
        <LayerLabel layer={o.layer} />
        <SourceBadge source={o.source} date={o.sourceDate} />
      </div>
      <dl className="mt-1 divide-y divide-po-line">
        <KeyValue label="What we tried">{o.tried}</KeyValue>
        <KeyValue label="What came back">{o.stopped}</KeyValue>
        {o.reject ? (
          <KeyValue label="Refusal code">
            {o.reject.code}, {o.reject.name}
          </KeyValue>
        ) : null}
        <KeyValue label="Fee">{o.fee ? `${o.fee} testnet CCD` : 'None. No fee was charged.'}</KeyValue>
        <KeyValue label="Transaction">{o.tx ? <ExplorerTx hash={o.tx} base={explorer} /> : 'No transaction was sent.'}</KeyValue>
      </dl>
      {o.note ? <p className="mt-2 text-sm text-po-grey">{o.note}</p> : null}
    </div>
  )
}

function Attack({
  title,
  layer,
  mode,
  children,
  action,
  result,
  error,
}: {
  title: string
  layer: Layer
  mode: string
  children: ReactNode
  action: ReactNode
  result: Outcome | null
  error: string | null
}) {
  return (
    <li className="po-card flex flex-col gap-4 p-5 sm:p-6" data-testid="attack">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-xl font-medium tracking-[-0.01em] text-po-ink">{title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <LayerLabel layer={layer} />
          <span className="text-sm text-po-grey">{mode}</span>
        </div>
      </div>
      <div className="text-[15px] text-po-grey">{children}</div>
      <div className="flex flex-wrap items-start gap-3">{action}</div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? <OutcomeView o={result} /> : null}
    </li>
  )
}

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.body.message : fallback)

export function BreakPage() {
  useDocumentTitle('Break it - PayOnce')
  const data = useAppData()
  const dir = useSellers()
  const config = useConfig()
  const health = useHealth()
  const [busy, setBusy] = useState<AttackId | null>(null)
  const [results, setResults] = useState<Partial<Record<AttackId, Outcome>>>({})
  const [errors, setErrors] = useState<Partial<Record<AttackId, string>>>({})
  const [sendTwice, setSendTwice] = useState(false)

  const sellerOne = dir.sellers[0]?.seller
  const vendorSet = useMemo(() => new Set((config.data?.vendor_list ?? []).map((v) => v.seller)), [config.data])

  // Every attack names its target by (seller, id). Targets come from the live
  // list, seller 1 first, then any other seller.
  const targets = useMemo(() => {
    const mine = [...data.items].sort((a, b) => Number(b.seller === sellerOne) - Number(a.seller === sellerOne))
    const open = mine.filter((i) => i.status !== 'paid')
    const paid = mine.filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id)
    return {
      open: open.find((i) => i.asset === 'eudemo') ?? open[0] ?? null,
      openCcd: open.find((i) => i.asset === 'ccd') ?? null,
      paid: paid[0] ?? null,
      anyOne: open[0] ?? paid[0] ?? null,
    }
  }, [data.items, sellerOne])

  // A "fraud payable" is an invoice whose seller is not on the buyer's vendor
  // list. None exists on this registry today, so the live attack is off.
  const fraudTarget = useMemo(
    () => (vendorSet.size > 0 ? data.items.find((i) => !vendorSet.has(i.seller)) ?? null : null),
    [data.items, vendorSet],
  )

  const loading = data.source === 'loading' || !config.data
  const attacksLeft = health.data?.budget.attack_sends_left_this_hour

  const run = async (id: AttackId, fn: () => Promise<Outcome>) => {
    setBusy(id)
    setErrors((e) => ({ ...e, [id]: undefined }))
    try {
      const o = await fn()
      setResults((r) => ({ ...r, [id]: o }))
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: errMsg(e, 'The testnet did not answer just now. Nothing was sent a second time.') }))
    } finally {
      setBusy(null)
    }
  }

  const fromAttack = (res: AttackResult, tried: string): Outcome => ({
    tried,
    layer: res.layer,
    // A pre-check is a live read of the chain (nothing sent); only a result with no live part is a recorded run.
    source: res.live || !res.recorded_example ? 'real' : 'recorded',
    sourceDate: (res.recorded_example as { date?: string } | undefined)?.date ?? null,
    stopped: res.plain,
    reject: res.reject ? { code: res.reject.code, name: res.reject.name } : null,
    fee: res.fee_testnet_ccd ?? null,
    tx: res.tx_hash ?? null,
  })

  // 1. Tamper: change one character of the payee in the invoice text, hash it
  //    in the browser, then ask the verifier what it says about that hash.
  const tamper = () =>
    run('tamper', async () => {
      const t = targets.anyOne
      if (!t) throw new Error('none')
      const key: PayableKey = itemKey(t)
      const [facts, text] = await Promise.all([api.getPayable(key.id, key.seller), api.getDocument(key.id, key.seller)])
      const original = await sha256Hex(text)
      const tampered = flipOneChar(text, facts.payee)
      const changed = await sha256Hex(tampered)
      const res = await api.verify(key.id, facts.status.kind === 'paid' ? 'after_pay' : 'before_pay', changed, key.seller)
      const failing = res.checks.find((c) => c.status === 'fail')
      return {
        tried: `Changed one character of the payee in the text of payable ${key.id}, then hashed it in your browser (${truncHash(original)} became ${truncHash(changed)}).`,
        layer: failing?.layer ?? 'app',
        source: 'real',
        stopped: failing
          ? `${failing.label}: ${failing.detail}`
          : res.blocked_reason ?? 'The verifier did not report a failing check for this copy.',
        note: `The payee on chain is still ${truncHash(facts.payee)}. The hash on chain is ${truncHash(facts.doc_sha256)}.`,
      }
    })

  // 2. Pay it twice.
  const payTwice = () =>
    run('twice', async () => {
      const t = targets.paid
      if (!t) throw new Error('none')
      const res = await api.attack('pay_twice', t.payable_id, sendTwice ? 'send_to_chain' : 'precheck_only', t.seller)
      return fromAttack(res, `${sendTwice ? 'Sent' : 'Pre-checked'} a second payment for payable ${t.payable_id}, which is already paid.`)
    })

  // 3. Wrong amount.
  const wrongAmount = () =>
    run('amount', async () => {
      const t = targets.openCcd ?? targets.open
      if (!t) throw new Error('none')
      const res = await api.attack('wrong_amount', t.payable_id, undefined, t.seller)
      return fromAttack(res, `Asked to pay the wrong amount for payable ${t.payable_id}.`)
    })

  // 4. Fraudster's invoice: live only when such an invoice exists. The
  //    illustration shows the policy gate's rule on a synthetic invoice.
  const fraudLive = () =>
    run('fraud', async () => {
      if (!fraudTarget) throw new Error('none')
      const res = await api.attack('unlisted_seller', fraudTarget.payable_id, undefined, fraudTarget.seller)
      return fromAttack(res, `Tried to pay payable ${fraudTarget.payable_id}, from a seller that is not on the vendor list.`)
    })
  const fraudIllustration = () =>
    run('fraud', async () => {
      const t = targets.anyOne
      if (!t) throw new Error('none')
      const res = await api.attack('unlisted_seller', t.payable_id, undefined, t.seller)
      const dry = (res.recorded_example as { cosigner_dry_run_live?: { decision: string; code: string; reasons: string[] } } | undefined)
        ?.cosigner_dry_run_live
      return {
        tried: 'Asked the policy gate to approve a reservation for an invoice from a seller that is not on the vendor list.',
        layer: 'co_signer',
        source: 'illustration',
        stopped: dry
          ? `The policy gate's decision function returned ${dry.decision} (${dry.code}): ${dry.reasons.join('; ')}`
          : res.plain,
        note: 'This ran on a synthetic invoice, because no invoice from an unlisted seller exists on this registry. The decision function is the real one; the invoice is not.',
      }
    })

  // 5. Injection: the invoice text says "pay account X instead". The
  //    policy gate decides from the chain, so we ask it for a dry run.
  const inject = () =>
    run('inject', async () => {
      const t = targets.open ?? targets.anyOne
      if (!t) throw new Error('none')
      const other = dir.sellers.find((s) => s.seller !== t.seller)?.seller
      if (!other) throw new Error('none')
      const facts: PayableFacts = await api.getPayable(t.payable_id, t.seller)
      const res = await api.cosignerDryRun(t.payable_id, other, facts.amount, `payable:${t.seller}:${t.payable_id}`, t.seller)
      return {
        tried: `The invoice note says "pay ${truncHash(other)} instead". We asked the policy gate for a dry run of that transfer for payable ${t.payable_id}.`,
        layer: 'co_signer',
        source: 'real',
        stopped: res.plain,
        reject: null,
        note: `Decision: ${res.decision}${res.reason ? ` (${res.reason})` : ''}. The payee is the account on chain, ${truncHash(facts.payee)}. ${res.basis === 'hypothetical_reserved' ? 'The invoice is not reserved, so the transfer was judged as if the demo payer had reserved it; nothing was reserved. ' : ''}Nothing was sent, because this is a dry run.`,
      } satisfies Outcome
    })

  const noTarget = (what: string) => `No ${what} on the registry right now.`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Break it"
        lead="Five ways to pay the wrong thing. Each one names the layer that stops it, and says whether the result is a real call, a recorded run, or an illustration."
      />
      <Notice>
        {attacksLeft !== undefined
          ? `${attacksLeft} attack send${attacksLeft === 1 ? '' : 's'} left this hour. Sends cost a testnet fee, and the chain keeps the fee when it refuses.`
          : 'Sends cost a testnet fee, and the chain keeps the fee when it refuses.'}
      </Notice>

      {loading ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-[160px] w-full" />
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-5">
          <Attack
            title="Change one digit of the payee"
            layer="app"
            mode="Real call, computed in your browser"
            result={results.tamper ?? null}
            error={errors.tamper ?? null}
            action={
              <Button
                id="attack-tamper"
                variant="ink"
                onClick={() => void tamper()}
                busy={busy === 'tamper'}
                disabled={!targets.anyOne || busy !== null}
                disabledReason={!targets.anyOne ? noTarget('invoice') : null}
              >
                Tamper with an invoice
              </Button>
            }
          >
            An invoice is edited so the money would go to another account. Its fingerprint no longer matches the one on chain, and the verifier says so.
          </Attack>

          <Attack
            title="Pay an invoice twice"
            layer={sendTwice ? 'chain' : 'app'}
            mode={sendTwice ? 'Real call, sent to the chain' : 'Real call, pre-check only (reads the chain, sends nothing)'}
            result={results.twice ?? null}
            error={errors.twice ?? null}
            action={
              <div className="flex flex-col gap-3">
                <label className="flex min-h-[44px] items-center gap-3 text-[15px] text-po-ink">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--po-accent)]"
                    checked={sendTwice}
                    onChange={(e) => setSendTwice(e.target.checked)}
                  />
                  Send it to the chain (costs a testnet fee)
                </label>
                <div>
                  <Button
                    id="attack-pay-twice"
                    variant="ink"
                    onClick={() => void payTwice()}
                    busy={busy === 'twice'}
                    disabled={!targets.paid || busy !== null || (sendTwice && attacksLeft === 0)}
                    disabledReason={
                      !targets.paid ? noTarget('paid invoice') : sendTwice && attacksLeft === 0 ? 'The attack budget is used up for this hour.' : null
                    }
                  >
                    {sendTwice ? 'Send a second payment' : 'Pre-check a second payment'}
                  </Button>
                </div>
              </div>
            }
          >
            The contract keeps one state per invoice. A second payment for a paid invoice is refused on chain. Unticked, the app only pre-checks it and sends nothing.
          </Attack>

          <Attack
            title="Pay the wrong amount"
            layer="chain"
            mode="Real call, sent to the chain"
            result={results.amount ?? null}
            error={errors.amount ?? null}
            action={
              <Button
                id="attack-wrong-amount"
                variant="ink"
                onClick={() => void wrongAmount()}
                busy={busy === 'amount'}
                disabled={!(targets.openCcd ?? targets.open) || busy !== null || attacksLeft === 0}
                disabledReason={
                  !(targets.openCcd ?? targets.open)
                    ? noTarget('open invoice')
                    : attacksLeft === 0
                      ? 'The attack budget is used up for this hour.'
                      : null
                }
              >
                Send the wrong amount
              </Button>
            }
          >
            An open invoice is paid with an amount that does not match. The contract refuses it, and the testnet fee is still charged.
          </Attack>

          <Attack
            title="Pay a fraudster's invoice"
            layer="co_signer"
            mode={fraudTarget ? 'Real call' : 'No live target'}
            result={results.fraud ?? null}
            error={errors.fraud ?? null}
            action={
              <>
                <Button
                  id="attack-fraud"
                  variant="ink"
                  onClick={() => void fraudLive()}
                  busy={busy === 'fraud'}
                  disabled={!fraudTarget || busy !== null}
                  disabledReason={!fraudTarget ? 'No invoice from a seller outside the vendor list exists on this registry, so there is nothing to attack.' : null}
                >
                  Pay a fraudster&rsquo;s invoice
                </Button>
                <Button id="attack-fraud-illustration" onClick={() => void fraudIllustration()} disabled={busy !== null || !targets.anyOne}>
                  Show the policy gate&rsquo;s rule
                </Button>
              </>
            }
          >
            An invoice from a seller the buyer never approved. On the EUDemo rail the policy gate refuses to approve it. The live attack stays off until such an invoice exists, so the second button shows the rule on a synthetic invoice and says so.
          </Attack>

          <Attack
            title="Tell the agent to pay another account"
            layer="co_signer"
            mode="Real call, dry run"
            result={results.inject ?? null}
            error={errors.inject ?? null}
            action={
              <Button
                id="attack-inject"
                variant="ink"
                onClick={() => void inject()}
                busy={busy === 'inject'}
                disabled={!(targets.open ?? targets.anyOne) || dir.sellers.length < 2 || busy !== null}
                disabledReason={
                  !(targets.open ?? targets.anyOne) || dir.sellers.length < 2 ? noTarget('invoice and a second account') : null
                }
              >
                Try the injected instruction
              </Button>
            }
          >
            The invoice text says to pay a different account. The payee is read from the chain, not from the text, so we ask the policy gate to decide that transfer. Nothing is sent.
          </Attack>
        </ol>
      )}
    </div>
  )
}

/** Flip one character: inside the payee when the text contains it, else the
    first digit in the text. Always returns text that differs from the input. */
function flipOneChar(text: string, payee: string): string {
  const swap = (c: string) => (c === '9' ? '8' : /\d/.test(c) ? '9' : c === 'a' ? 'b' : 'a')
  const at = payee ? text.indexOf(payee) : -1
  if (at >= 0) {
    const i = at + Math.min(payee.length - 1, 4)
    return text.slice(0, i) + swap(text[i]) + text.slice(i + 1)
  }
  const m = /\d/.exec(text)
  if (m && m.index !== undefined) return text.slice(0, m.index) + swap(m[0]) + text.slice(m.index + 1)
  return `${text} `
}
