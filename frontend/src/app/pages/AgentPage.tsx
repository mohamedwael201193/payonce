// Agent pays: the latest real agent run as a timeline. Task, discovery, the checks in both directions,
// paid or refused with the reason and who refused, then the receipts and the keyless verifier command.
// Everything on this page comes from a run record (live from the API, else the recorded run bundled
// with the app). The scripted planner is labelled as a script, never as a language model. Testnet only.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Address } from '../Address'
import { CopyButton, ExplorerTx, KeyValue, Notice, PageHeader, Skeleton, StatusPill, Button, useExplorerBase } from '../ui'
import { useDocumentTitle } from '../hooks'
import { clockUtc } from '../format'
import recordedJson from '../data/agentRun.json'
import {
  groupChecks,
  hostileLabel,
  isAgentRun,
  outcomeLabel,
  outcomeTone,
  plannerBadge,
  refusedByLayer,
  type AgentCheck,
  type AgentDecision,
  type AgentRun,
} from '../../lib/agentRun'

const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/[/]$/, '')
const PUBLIC_API = API_BASE || 'https://payonce-api-n98a.onrender.com'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

interface AgentStatus {
  run_enabled: boolean
  disabled_reason: string | null
  running: { run_id: string; started_at: string; events: Array<{ at: string; text: string }> } | null
  last_error?: { at: string; message: string } | null
  planner: string
}

const recorded: AgentRun | null = isAgentRun(recordedJson) ? (recordedJson as unknown as AgentRun) : null

function useLatestRun(): { run: AgentRun | null; source: 'live' | 'recorded' | 'loading'; refetch: () => void } {
  const q = useQuery({
    queryKey: ['agent-latest'],
    queryFn: () => getJson<AgentRun>('/api/agent/latest'),
    retry: 1,
    staleTime: 30_000,
  })
  if (q.data && isAgentRun(q.data)) {
    const kind = q.data._source?.kind === 'live' ? 'live' : 'recorded'
    return { run: q.data, source: kind, refetch: () => void q.refetch() }
  }
  if (q.isLoading && !recorded) return { run: null, source: 'loading', refetch: () => void q.refetch() }
  return { run: recorded, source: 'recorded', refetch: () => void q.refetch() }
}

function CheckRow({ c }: { c: AgentCheck }) {
  const tone = c.status === 'ok' ? 'ok' : c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : 'neutral'
  const word = c.status === 'ok' ? 'Pass' : c.status === 'fail' ? 'Fail' : c.status === 'warn' ? 'Note' : 'Not run'
  return (
    <li className="grid grid-cols-[72px_1fr] items-start gap-3 py-2" data-testid="agent-check">
      <span className="pt-0.5">
        <StatusPill tone={tone}>{word}</StatusPill>
      </span>
      <span className="min-w-0 text-[15px] text-po-ink">
        {c.label}
        {c.detail ? <span className="mt-0.5 block text-sm text-po-grey [overflow-wrap:anywhere]">{c.detail}</span> : null}
      </span>
    </li>
  )
}

function DecisionCard({ d, index, explorer }: { d: AgentDecision; index: number; explorer: string }) {
  const groups = useMemo(() => groupChecks(d.checks ?? []), [d.checks])
  const hostile = hostileLabel(d.hostile_fixture)
  const paid = d.outcome === 'paid'
  const failing = (d.checks ?? []).filter((c) => c.status === 'fail')
  return (
    <li className="po-card flex flex-col gap-4 p-5 sm:p-6" data-testid="agent-decision" data-outcome={d.outcome}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-po-grey">
            Email {index + 1} from {d.from}
          </p>
          <h3 className="text-xl font-medium tracking-[-0.01em] text-po-ink [overflow-wrap:anywhere]">{d.subject}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hostile ? <span className="po-chip po-chip-neutral">{hostile}</span> : null}
          <StatusPill tone={outcomeTone(d.outcome)}>{outcomeLabel(d.outcome)}</StatusPill>
        </div>
      </div>

      {paid ? (
        <div className="rounded-[10px] border border-po-line bg-po-paper p-4" data-testid="agent-paid">
          <p className="text-[15px] text-po-ink">
            Every check passed in both directions. Paid {d.facts?.amount_display ?? d.receipt?.amount}
            {d.rail ? ` on the ${d.rail === 'ccd' ? 'CCD' : 'EUDemo'} rail` : ''}.
          </p>
          <dl className="mt-1 divide-y divide-po-line">
            {(d.txs ?? []).map((t) => (
              <KeyValue key={t.tx_hash} label={t.step ? `Transaction (${t.step})` : 'Transaction'}>
                <ExplorerTx hash={t.tx_hash} base={explorer} />
              </KeyValue>
            ))}
            {d.receipt?.verifier_reread ? (
              <KeyValue label="Verifier, server re-read">
                {d.receipt.verifier_reread.passed}/{d.receipt.verifier_reread.total} checks pass
              </KeyValue>
            ) : null}
            {d.verifier_run?.ran ? (
              <KeyValue label="Keyless verifier, run by the agent">
                {d.verifier_run.pass ? 'ALL CHECKS PASS' : 'Did not pass'} ({d.verifier_run.passed}/{d.verifier_run.total})
              </KeyValue>
            ) : null}
            {d.receipt?.anchor_tx ? (
              <KeyValue label="Decision record anchor">
                <ExplorerTx hash={d.receipt.anchor_tx} base={explorer} />
              </KeyValue>
            ) : null}
          </dl>
          {d.keyless_verifier ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-po-grey">Run the verifier yourself (no key needed)</summary>
              <pre className="mt-2 overflow-x-auto rounded-[8px] bg-po-surface p-3 font-mono text-[12.5px] text-po-ink">{`${d.keyless_verifier.fetch_document}\n${d.keyless_verifier.run}`}</pre>
              <CopyButton value={`${d.keyless_verifier.fetch_document}\n${d.keyless_verifier.run}`} label="commands" />
            </details>
          ) : null}
        </div>
      ) : (
        <div className="rounded-[10px] border border-po-line bg-po-paper p-4" data-testid="agent-refusal">
          <p className="text-[15px] text-po-ink">
            {d.outcome === 'held' ? 'Not paid yet.' : 'Nothing was sent.'} {refusedByLayer(d.refused_by) ? `Stopped by: ${refusedByLayer(d.refused_by)}.` : ''}
          </p>
          {failing.length ? (
            <ul className="mt-2 list-disc pl-5 text-[15px] text-po-ink">
              {failing.slice(0, 4).map((c) => (
                <li key={c.id} className="[overflow-wrap:anywhere]">
                  {c.detail || c.label}
                </li>
              ))}
            </ul>
          ) : d.reason ? (
            <p className="mt-2 text-[15px] text-po-ink [overflow-wrap:anywhere]">{d.reason}</p>
          ) : null}
        </div>
      )}

      {d.age_gate?.required || d.age_proof ? (
        <div className="rounded-[10px] border border-po-line p-4" data-testid="agent-age">
          <p className="text-[15px] font-medium text-po-ink">Age-restricted invoice (18+)</p>
          <p className="mt-1 text-sm text-po-grey">
            {d.age_proof
              ? d.age_proof.ok
                ? 'The buyer presented a fresh V&A V1 proof of 18+ from the paying account. No attribute value was revealed.'
                : `No proof could be produced: ${d.age_proof.reason ?? 'unavailable'}. The invoice stayed unpaid.`
              : 'A proof is required before this invoice is paid.'}
          </p>
          {d.age_proof?.ok && (d.age_proof.vra_tx || d.age_proof.vaa_tx) ? (
            <dl className="mt-1 divide-y divide-po-line">
              {d.age_proof.vra_tx ? (
                <KeyValue label="Request anchor (VRA)">
                  <ExplorerTx hash={d.age_proof.vra_tx} base={explorer} />
                </KeyValue>
              ) : null}
              {d.age_proof.vaa_tx ? (
                <KeyValue label="Audit anchor (VAA)">
                  <ExplorerTx hash={d.age_proof.vaa_tx} base={explorer} />
                </KeyValue>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}

      {groups.length ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-po-ink">
            Checks, both directions ({(d.checks ?? []).filter((c) => c.status === 'ok').length} pass, {failing.length} fail)
          </summary>
          <div className="mt-3 grid gap-5 sm:grid-cols-2">
            {groups.map((g) => (
              <div key={g.side}>
                <h4 className="text-sm font-medium text-po-grey">{g.title}</h4>
                <ul className="divide-y divide-po-line">
                  {g.checks.map((c) => (
                    <CheckRow key={c.id} c={c} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </li>
  )
}

function RunPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['agent-status'],
    queryFn: () => getJson<AgentStatus>('/api/agent/status'),
    retry: 0,
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = Boolean(status.data?.running)
  useEffect(() => {
    if (status.data && !status.data.running && busy) {
      setBusy(false)
      onDone()
      void qc.invalidateQueries({ queryKey: ['agent-latest'] })
    }
  }, [status.data, busy, onDone, qc])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      void status.refetch()
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'The run could not start.')
    }
  }

  if (status.isLoading) return <Skeleton className="h-16 w-full" />
  if (status.isError || !status.data) return <p className="text-sm text-po-grey">The run control is not available from this API.</p>
  if (!status.data.run_enabled) return <p className="max-w-[64ch] text-sm text-po-grey">{status.data.disabled_reason}</p>
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="primary" onClick={() => void start()} busy={busy || running} disabled={busy || running}>
          Run the agent
        </Button>
        <p className="mt-2 max-w-[64ch] text-sm text-po-grey">
          Registers three small test invoices and pays what passes, with real testnet transactions. One run per 20 minutes for the whole server; the planner is {status.data.planner === 'llm' ? 'a language model' : 'the labelled script'}.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.data.running ? (
        <ol className="max-h-56 overflow-auto rounded-[10px] border border-po-line p-3 text-sm text-po-grey" aria-live="polite" data-testid="agent-live-events">
          {status.data.running.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="[overflow-wrap:anywhere]">
              {clockUtc(e.at)} {e.text}
            </li>
          ))}
        </ol>
      ) : null}
      {status.data.last_error && !running ? <Notice tone="warn">The last run on this server did not finish: {status.data.last_error.message}</Notice> : null}
    </div>
  )
}

export function AgentPage() {
  useDocumentTitle('Agent pays')
  const { run, source, refetch } = useLatestRun()
  const explorer = useExplorerBase()
  const mcpCurl = `curl -s -X POST ${PUBLIC_API}/mcp -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
  const stdioConfig = `{\n  "mcpServers": {\n    "payonce": {\n      "command": "node",\n      "args": ["agent/mcp-server/server.mjs"],\n      "env": { "PAYONCE_API_URL": "${PUBLIC_API}" }\n    }\n  }\n}`

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Agent pays"
        lead="An agent gets a task, reads an inbox of invoices, checks each one in both directions, pays what is legitimate and refuses the rest. This is the latest real run on the Concordium testnet."
      />

      {!run ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <section aria-label="Run summary" className="po-card flex flex-col gap-4 p-5 sm:p-6" data-testid="agent-summary">
            <div className="flex flex-wrap items-center gap-2">
              <span className="po-chip po-chip-neutral" data-testid="agent-planner">
                {plannerBadge(run.planner)}
              </span>
              <span className="po-chip po-chip-neutral">{source === 'live' ? 'Run by this server' : `Recorded run, ${run.started_at.slice(0, 10)}`}</span>
              <span className="po-chip po-chip-neutral">Testnet</span>
            </div>
            <div>
              <p className="text-sm font-medium text-po-grey">Task</p>
              <p className="mt-1 text-[19px] leading-snug text-po-ink">{run.task}</p>
            </div>
            <dl className="divide-y divide-po-line">
              <KeyValue label="Result">
                Paid {run.totals.paid}, refused {run.totals.refused}
                {run.totals.held ? `, waiting for the owner ${run.totals.held}` : ''}
              </KeyValue>
              <KeyValue label="Spent">
                {(Number(run.totals.spent.ccd) / 1e6).toFixed(2)} CCD, {(Number(run.totals.spent.eudemo) / 1e6).toFixed(2)} EUDemo (testnet units)
              </KeyValue>
              <KeyValue label="Approved suppliers">
                <span className="flex flex-col gap-1">
                  {run.mandate.approved_suppliers.map((s) => (
                    <Address key={s} value={s} kind="account" label="approved supplier" />
                  ))}
                </span>
              </KeyValue>
              {run.buyer_agent?.token ? (
                <KeyValue label="Buyer agent">
                  Token {run.buyer_agent.token} on the official registry, paying account{' '}
                  {run.buyer_agent.account ? <Address value={run.buyer_agent.account} kind="account" label="paying account" /> : null}
                </KeyValue>
              ) : null}
              <KeyValue label="Run">
                {clockUtc(run.started_at)} to {clockUtc(run.finished_at)} UTC
              </KeyValue>
            </dl>
          </section>

          <section aria-label="Timeline" className="flex flex-col gap-4">
            <h2 className="text-[28px] font-medium tracking-[-0.02em] text-po-ink sm:text-[40px]">What the agent did</h2>
            <ol className="flex flex-col gap-5" data-testid="agent-timeline">
              <li className="po-card p-5 sm:p-6" data-testid="agent-step-discover">
                <h3 className="text-xl font-medium text-po-ink">Found the work</h3>
                <p className="mt-1 text-[15px] text-po-grey">
                  {run.decisions.length} emails in the inbox, each naming a payable. The agent listed the open payables through the PayOnce tools, then checked them one by one. Emails are seed data written for this demo; the payables are real registry rows.
                </p>
              </li>
              {run.decisions.map((d, i) => (
                <DecisionCard key={d.email_id} d={d} index={i} explorer={explorer} />
              ))}
              <li className="po-card p-5 sm:p-6" data-testid="agent-step-final">
                <h3 className="text-xl font-medium text-po-ink">Finished</h3>
                <p className="mt-1 text-[15px] text-po-ink">
                  Paid {run.totals.paid} and refused {run.totals.refused}. Each refusal names who stopped it.
                </p>
              </li>
            </ol>
          </section>

          <section aria-label="Rules and limits" className="po-card p-5 sm:p-6">
            <h2 className="text-xl font-medium text-po-ink">What bounds the agent, and what does not</h2>
            <ul className="mt-3 list-disc pl-5 text-[15px] text-po-ink">
              {run.mandate.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-po-ink">Honest limits of this run</summary>
              <ul className="mt-2 list-disc pl-5 text-sm text-po-grey">
                {run.honesty.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </details>
          </section>
        </>
      )}

      <section aria-label="Run the agent" className="po-card flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-xl font-medium text-po-ink">Run it</h2>
        <RunPanel onDone={refetch} />
      </section>

      <section aria-label="Use it from your own agent" className="po-card flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-xl font-medium text-po-ink">Use PayOnce from your own agent</h2>
        <p className="max-w-[64ch] text-[15px] text-po-grey">
          The same four tools are a hosted, read-only MCP endpoint (list_payables, check_payable, receipt) and a local MCP server that can also pay, through the API, under the vendor list, the caps and the co-signer.
        </p>
        <pre className="overflow-x-auto rounded-[8px] bg-po-surface p-3 font-mono text-[12.5px] text-po-ink">{mcpCurl}</pre>
        <div>
          <CopyButton value={mcpCurl} label="curl command" />
        </div>
        <pre className="overflow-x-auto rounded-[8px] bg-po-surface p-3 font-mono text-[12.5px] text-po-ink">{stdioConfig}</pre>
      </section>
    </div>
  )
}
