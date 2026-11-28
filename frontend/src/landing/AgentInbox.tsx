// The first 30 seconds: the agent's last real run on testnet, as an inbox.
// Refusals lead (a fake invoice stopped before any money moved), then the
// invoices paid exactly once. Every row comes from a run record: live from the
// API, else the run bundled with the app. Nothing here is typed by hand.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Tag } from './bits'
import { isAgentRun, type AgentDecision, type AgentRun } from '../lib/agentRun'

const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/[/]$/, '')

export interface InboxRow {
  key: string
  supplier: string
  subject: string
  outcome: 'refused' | 'paid' | 'other'
  why: string
  amount: string | null
  href: string | null
}

/** "billing@alder-bakery.example" -> "Alder Bakery". */
export function supplierName(from: string): string {
  const host = (from.split('@')[1] ?? from).replace(/\.(example|test|invalid)$/i, '').split('.')[0]
  return host
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^(co|ltd|inc|llc)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/** One short reason for a refusal, from the run record's own codes. */
export function refusalWhy(d: Pick<AgentDecision, 'hostile_fixture' | 'reason_code' | 'age_gate'>): string {
  if (d.hostile_fixture === 'unlisted_seller' || d.reason_code === 'seller_known') return 'Seller is not one you approved'
  if (d.hostile_fixture === 'payee_change') return 'Account on the invoice is not the seller’s'
  if (d.hostile_fixture === 'tampered_document' || d.reason_code === 'attachment_matches_chain') return 'Invoice differs from the one on chain'
  if (d.reason_code === 'no_instructions_in_invoice') return 'The email tried to give the agent orders'
  if (d.age_gate?.required && d.age_gate.proof_on_file === false) return 'Needs an 18+ proof first'
  return 'Stopped before any money moved'
}

/** "0.500000 CCD" -> "0.5 CCD"; "10 CCD" stays "10 CCD". */
export function trimAmount(a: string): string {
  return a.replace(/^(\d+)\.(\d*?)0+(\s)/, (_m, i: string, f: string, sp: string) => (f ? `${i}.${f}${sp}` : `${i}${sp}`))
}

export function inboxRows(run: AgentRun): InboxRow[] {
  const rows = run.decisions.map((d, i): InboxRow => {
    const outcome = d.outcome === 'paid' ? 'paid' : d.outcome === 'refused' ? 'refused' : 'other'
    const seller = d.seller ?? ''
    return {
      key: `${d.email_id}-${i}`,
      supplier: supplierName(d.from),
      subject: d.subject,
      outcome,
      why: outcome === 'paid' ? 'Paid once to the seller’s account on chain' : outcome === 'refused' ? refusalWhy(d) : 'Not processed',
      amount: d.facts?.amount_display ? trimAmount(d.facts.amount_display) : null,
      href: outcome === 'paid' && d.payable_id && seller ? `/app/receipt/${seller}/${d.payable_id}` : null,
    }
  })
  // The failure case first: what the agent refused, then what it paid.
  const rank = { refused: 0, paid: 1, other: 2 } as const
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.outcome] - rank[b.r.outcome] || a.i - b.i).map((x) => x.r)
}

function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  return `${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

type Loaded = { run: AgentRun; source: 'live' | 'recorded' }

function useAgentRun(initial?: AgentRun | null): Loaded | null {
  const [state, setState] = useState<Loaded | null>(initial ? { run: initial, source: 'recorded' } : null)
  useEffect(() => {
    let off = false
    const fallback = () =>
      import('../app/data/agentRun.json').then((m) => {
        const r = (m as { default: unknown }).default
        if (!off && isAgentRun(r)) setState((s) => s ?? { run: r, source: 'recorded' })
      })
    fetch(`${API_BASE}/api/agent/latest`, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((r: unknown) => {
        if (off) return
        if (isAgentRun(r)) setState({ run: r, source: r._source?.kind === 'live' ? 'live' : 'recorded' })
        else void fallback()
      })
      .catch(() => void fallback())
    return () => {
      off = true
    }
  }, [])
  return state
}

export function AgentInboxPanel({ initial }: { initial?: AgentRun | null }) {
  const loaded = useAgentRun(initial)
  if (!loaded) {
    return (
      <div className="po-panel po-inbox" data-testid="hero-inbox" aria-busy="true">
        <div className="po-panel__bar">
          <strong>Accounts-payable inbox</strong>
          <span className="po-chip">Testnet</span>
        </div>
        <p className="po-inbox__wait">Loading the agent's last run…</p>
      </div>
    )
  }
  const { run, source } = loaded
  const rows = inboxRows(run)
  const refused = rows.filter((r) => r.outcome === 'refused').length
  const paid = rows.filter((r) => r.outcome === 'paid').length
  return (
    <div className="po-panel po-inbox" data-testid="hero-inbox">
      <div className="po-panel__bar">
        <strong>Accounts-payable inbox</strong>
        <span className="po-chip">Testnet</span>
        <span className="po-panel__spacer" />
        <Tag kind={source === 'live' ? 'live' : 'recorded'}>
          Agent run, {stamp(run.finished_at ?? run.started_at)}
        </Tag>
      </div>
      <ol className="po-inbox__steps" aria-label="What the agent does">
        <li><b>1</b> Reads the invoice</li>
        <li><b>2</b> Checks who it’s paying</li>
        <li><b>3</b> No match: stops. Match: pays once</li>
      </ol>
      <ul className="po-inbox__list">
        {rows.map((r) => (
          <li key={r.key} className={`po-inbox__row po-inbox__row--${r.outcome}`} data-testid="inbox-row">
            <div className="po-inbox__who">
              <strong>{r.supplier}</strong>
              <span>{r.subject}</span>
            </div>
            <div className="po-inbox__verdict">
              <span className={`po-status po-status--${r.outcome === 'paid' ? 'paid' : r.outcome === 'refused' ? 'refused' : 'unpaid'}`}>
                {r.outcome === 'paid' ? 'Match' : r.outcome === 'refused' ? 'No match' : 'Skipped'}
              </span>
              <span className="po-inbox__why">
                {r.why}
                {r.amount && r.outcome === 'paid' ? ` · ${r.amount.replace('EUDemo', 'EUDemo (testnet euro token)')}` : ''}
              </span>
              {r.href ? (
                <Link className="po-inbox__link" to={r.href}>
                  Receipt
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="po-inbox__foot">
        <span>
          {refused} no match, stopped before any money moved. {paid} matched and paid exactly once. The checks are code the agent cannot change.
        </span>
        <Link to="/app/proof/agent">Open the full run</Link>
      </p>
    </div>
  )
}
