// Agent pays: the latest real agent run as a timeline. Task, discovery, the checks in both directions,
// paid or refused with the reason and who refused, then the receipts and the keyless verifier command.
// Everything on this page comes from a run record (live from the API, else the recorded run bundled
// with the app). The scripted planner is labelled as a script, never as a language model. Testnet only.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Address } from '../Address'
import { CopyButton, ExplorerTx, KeyValue, Notice, PageHeader, Skeleton, StatusPill, Button, useExplorerBase } from '../ui'
import { markMilestone, useDocumentTitle } from '../hooks'
import { clockUtc } from '../format'
import recordedJson from '../data/agentRun.json'
import {
  correctionText,
  groundProse,
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
  plainEvent,
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
  planner: { kind: string; label: string }
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
              <KeyValue label="Server re-read after paying">
                {d.receipt.verifier_reread.passed === d.receipt.verifier_reread.total ? 'All ' : ''}{d.receipt.verifier_reread.passed} of {d.receipt.verifier_reread.total} checks pass
              </KeyValue>
            ) : null}
            {d.verifier_run?.ran ? (
              <KeyValue label="Public verifier script, run by the agent (no keys)">
                {d.verifier_run.pass ? 'All ' : ''}{d.verifier_run.passed} of {d.verifier_run.total} checks pass
                {d.verifier_run.pass ? '' : ' (the rest did not pass or were not run)'}
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
          <p className="mt-1 text-xs text-po-grey" data-testid="agent-age-honesty">
            The proof comes from a separate prover service that holds only the dob and nationality openings
            of the paying account's credential; the API holds no identity data. It is a stand-in for
            Concordium's coming Agent IDP.
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

function useAgentStatus() {
  return useQuery({
    queryKey: ['agent-status'],
    queryFn: () => getJson<AgentStatus>('/api/agent/status'),
    retry: 0,
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  })
}

/** Live run as a state machine: idle -> starting -> running (one plain current step) -> finished (the new run loads below). */
function RunPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const status = useAgentStatus()
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'finished'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const running = status.data?.running ?? null
  const sawRunning = useRef(false)
  useEffect(() => {
    if (running) {
      sawRunning.current = true
      if (phase !== 'running') setPhase('running')
      return
    }
    if (phase === 'running' && sawRunning.current && status.data && !status.isFetching) {
      sawRunning.current = false
      setPhase('finished')
      onDone()
      void qc.invalidateQueries({ queryKey: ['agent-latest'] })
    }
  }, [running, phase, status.data, status.isFetching, onDone, qc])
  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [phase])

  async function start() {
    setPhase('starting')
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      setPhase('running')
      void status.refetch()
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'The run could not start.')
    }
  }

  if (status.isLoading) return <Skeleton className="h-16 w-full" />
  if (status.isError || !status.data) return <p className="text-sm text-po-grey">The run control is not available from this API.</p>
  if (!status.data.run_enabled) return <p className="max-w-[64ch] text-sm text-po-grey">{status.data.disabled_reason}</p>
  const events = running?.events ?? []
  const current = events.length ? plainEvent(events[events.length - 1].text) : 'Starting the run…'
  const since = running?.started_at ? Math.max(0, Math.round((now - Date.parse(running.started_at)) / 1000)) : null
  return (
    <div className="flex flex-col gap-3" data-testid="agent-run-panel" data-phase={phase}>
      {phase === 'running' || phase === 'starting' ? (
        <div className="rounded-[10px] border border-po-line bg-po-paper p-4" aria-live="polite">
          <p className="text-sm text-po-grey">Running now{since != null ? `, ${since} s` : ''}. The previous run stays below until this one finishes.</p>
          <p className="mt-1 text-[19px] leading-snug text-po-ink [overflow-wrap:anywhere]" data-testid="agent-live-current">{current}</p>
          {events.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-po-grey">Every step so far ({events.length})</summary>
              <ol className="mt-2 max-h-56 overflow-auto text-sm text-po-grey" data-testid="agent-live-events">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="[overflow-wrap:anywhere]">
                    {clockUtc(e.at)} {plainEvent(e.text)}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ) : (
        <div>
          <Button variant="primary" onClick={() => void start()}>
            {phase === 'finished' ? 'Run it again' : 'Run the agent now'}
          </Button>
          <p className="mt-2 max-w-[64ch] text-sm text-po-grey">
            Registers three small test invoices and pays what passes, with real testnet transactions. One run per 20 minutes for the whole server; the planner is {status.data.planner.label}. Amounts and verdicts come from the API, never from the model.
          </p>
        </div>
      )}
      {phase === 'finished' ? <Notice tone="info">The run finished. Its result is shown below.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.data.last_error && !running ? <Notice tone="warn">The last run on this server did not finish: {status.data.last_error.message}</Notice> : null}
    </div>
  )
}

export function AgentPage() {
  useDocumentTitle('The agent at work')
  const { run, source, refetch } = useLatestRun()
  const explorer = useExplorerBase()
  const liveStatus = useAgentStatus()
  const runningNow = Boolean(liveStatus.data?.running)
  useEffect(() => {
    if (run) markMilestone('agent')
  }, [run])
  const mcpCurl = `curl -s -X POST ${PUBLIC_API}/mcp -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
  const stdioConfig = `{\n  "mcpServers": {\n    "payonce": {\n      "command": "node",\n      "args": ["agent/mcp-server/server.mjs"],\n      "env": { "PAYONCE_API_URL": "${PUBLIC_API}" }\n    }\n  }\n}`

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="The agent at work"
        lead="The agent reads an inbox of invoices and checks who each one would pay. Match: it pays once. No match: nothing moves. Emails that try to give it orders are refused by its safety layer. This is the latest real run on the Concordium testnet."
      />

      <section aria-label="Run the agent" className="po-card flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-xl font-medium text-po-ink">Run the agent yourself</h2>
        <RunPanel onDone={refetch} />
      </section>


      {!run ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <section aria-label="Run summary" className="po-card flex flex-col gap-4 p-5 sm:p-6" data-testid="agent-summary">
            <div className="flex flex-wrap items-center gap-2">
              <span className="po-chip po-chip-neutral" data-testid="agent-planner">
                {plannerBadge(run.planner)}
              </span>
              <span className="po-chip po-chip-neutral">{runningNow ? 'Previous run' : source === 'live' ? 'Run by this server' : `Recorded run, ${run.started_at.slice(0, 10)}`}</span>
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
                {clockUtc(run.started_at)} to {clockUtc(run.finished_at)}
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

          {run.post_run_notes?.length ? (
            <section aria-label="After the run" className="po-card p-5 sm:p-6" data-testid="agent-post-run">
              <h2 className="text-xl font-medium text-po-ink">After the run</h2>
              <ul className="mt-2 list-disc pl-5 text-[15px] text-po-ink">
                {run.post_run_notes.map((n) => (
                  <li key={n.payable_id} className="[overflow-wrap:anywhere]">
                    Payable {n.payable_id}: {n.text}
                    {n.confirm_tx ? (
                      <span className="mt-1 block">
                        <ExplorerTx hash={n.confirm_tx} base={explorer} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {run.planner.kind === 'llm' && run.transcript.some((e) => e.source === 'model_prose') ? (
            <section aria-label="What the model said" className="po-card p-5 sm:p-6" data-testid="agent-model-prose">
              <details>
                <summary className="cursor-pointer text-xl font-medium text-po-ink">What the model said</summary>
                <p className="mt-2 text-sm text-po-grey">This is the model&apos;s own wording, shown as it wrote it. It can be wrong, for example about amounts or about whether an invoice was paid. Every amount, verdict and transaction above comes from the API, not from this text; a sentence that contradicts the run record is marked with what the record shows.</p>
                <ol className="mt-3 flex flex-col gap-2 text-[15px] text-po-ink">
                  {run.transcript.filter((e) => e.source === 'model_prose' && e.text).map((e) => {
                    const fixes = groundProse(e.text ?? '', run)
                    return (
                      <li key={e.seq} className="[overflow-wrap:anywhere]">
                        {e.text}
                        {fixes.map((c) => (
                          <span key={`${c.payable_id}-${c.text}`} className="mt-1 block rounded-[6px] border border-po-warn-line bg-po-warn-bg px-2 py-1 text-[13px] text-po-warn" data-testid="prose-correction">
                            {correctionText(c, run)}
                          </span>
                        ))}
                      </li>
                    )
                  })}
                </ol>
              </details>
            </section>
          ) : null}

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

      <section aria-label="Use it from your own agent" className="po-card flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-xl font-medium text-po-ink">Use PayOnce from your own agent</h2>
        <p className="max-w-[64ch] text-[15px] text-po-grey">
          The same four tools are a hosted, read-only MCP endpoint (list_payables, check_payable, receipt) and a local MCP server that can also pay, through the API, under the vendor list, the caps and the policy gate.
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
