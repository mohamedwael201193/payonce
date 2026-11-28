// The Run-it flow as plain data: the steps, and how a live verify result maps
// to Match / No match. Kept free of React so it is unit-tested on its own.
import type { VerifyResponse } from '../../lib/types'

export const STEPS = ['Payer', 'Invoice', 'Check', 'Approve', 'Paid once'] as const
export type StepIndex = 0 | 1 | 2 | 3 | 4

export interface Reason {
  ok: boolean
  text: string
}

export type Verdict =
  | { kind: 'match'; reasons: Reason[] }
  | { kind: 'no_match'; reasons: Reason[]; headline: string }
  | { kind: 'paid'; reasons: Reason[] }

type Check = VerifyResponse['checks'][number]

const PLAIN: Record<string, { ok: string; fail: string }> = {
  agent: { ok: 'The seller is a registered agent on Concordium.', fail: 'The seller is not an active registered agent.' },
  doc: {
    ok: 'The invoice is exactly the one the seller put on chain, payee account included.',
    fail: 'This is not the invoice the seller put on chain: its fingerprint differs, so the account on it cannot be trusted.',
  },
  status: { ok: 'It has not been paid yet.', fail: 'It is already paid.' },
  due: { ok: 'It is not past due.', fail: 'It is past due.' },
  registered: { ok: 'The invoice is registered on chain.', fail: 'No such invoice is registered on chain.' },
  balance: { ok: 'The payer can cover it.', fail: 'The payer cannot cover it right now.' },
}
const ORDER = ['agent', 'doc', 'status', 'due', 'registered', 'balance']

/** Live verify result -> the one verdict the page shows, with at most four plain reasons. */
export function toVerdict(v: Pick<VerifyResponse, 'verdict' | 'checks' | 'blocked_reason'>): Verdict {
  const byId = new Map<string, Check>(v.checks.map((c) => [c.id, c]))
  const failed = ORDER.filter((id) => byId.get(id)?.status === 'fail')
  const reasonsFor = (ids: string[]): Reason[] =>
    ids
      .filter((id) => byId.has(id) && PLAIN[id])
      .map((id) => {
        const ok = byId.get(id)!.status !== 'fail'
        return { ok, text: ok ? PLAIN[id].ok : PLAIN[id].fail }
      })
  if (v.verdict === 'paid') return { kind: 'paid', reasons: reasonsFor(['status']) }
  if (v.verdict === 'ready' && failed.length === 0) return { kind: 'match', reasons: reasonsFor(['agent', 'doc', 'status', 'due']) }
  const first = failed[0] ?? v.blocked_reason ?? ''
  const headline = PLAIN[first]?.fail ?? 'One of the checks failed, so nothing is sent.'
  const rest = ['agent', 'doc', 'status', 'due'].filter((id) => id !== first)
  // The headline already says the failed check; the list shows the other checks, so nothing is said twice.
  return { kind: 'no_match', headline, reasons: reasonsFor(rest).slice(0, 3) }
}

/** The fake: the same invoice text with the payee line pointed at another account. */
export const FAKE_PAYEE = '3kBx2h5Y8v3TfqmRZ3BmvNwKUX4ZRVJcVLRsC9cBRwLX9pYgyR'
export function forgePayee(doc: string, to = FAKE_PAYEE): string {
  return doc.replace(/^(Payee:\s*)\S+/m, `$1${to}`)
}

/** "0.100000 CCD" -> "0.1 CCD". */
export function tidy(amount: string): string {
  return amount.replace(/^(\d+)\.(\d*?)0+(\s)/, (_m, i: string, f: string, sp: string) => (f ? `${i}.${f}${sp}` : `${i}${sp}`))
}
