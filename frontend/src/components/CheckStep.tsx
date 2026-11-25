// Step 2 — Check (P3 §7.2, §7.2a). Nine check rows against the testnet
// registry and the seller's agent. A check that was not run never counts as
// a pass. Verdict: ready / blocked / paid.
import { CheckCircle2, CircleDashed, Info, Loader2, XCircle } from 'lucide-react'
import type { CheckRow, VerifyResponse } from '../lib/types'
import { COPY } from '../lib/copy'
import { AlertInline, PrimaryButton, StepCard } from './ui'

function CheckIcon({ status }: { status: CheckRow['status'] }) {
  switch (status) {
    case 'ok':
      return <CheckCircle2 className="h-5 w-5 text-verified" aria-label="Passed" />
    case 'fail':
      return <XCircle className="h-5 w-5 text-refused" aria-label="Failed" />
    case 'info':
      return <Info className="h-5 w-5 text-muted" aria-label="Information" />
    default:
      return <CircleDashed className="h-5 w-5 text-muted" aria-label="Not run" />
  }
}

export function CheckList({ result }: { result: VerifyResponse }) {
  return (
    <ul className="divide-y divide-line border border-line bg-card">
      {result.checks.map((c) => (
        <li key={c.id} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 shrink-0">
            <CheckIcon status={c.status} />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink">{c.label}</p>
            <p className="text-sm text-muted">{c.detail}</p>
          </div>
          <span className="ml-auto shrink-0 text-xs font-medium text-muted">
            {c.status === 'ok' ? 'Passed' : c.status === 'fail' ? 'Blocked' : c.status === 'info' ? 'Info' : 'Not run'}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function CheckStep({
  onCheck,
  state,
}: {
  onCheck: () => void
  state:
    | { kind: 'idle' }
    | { kind: 'running'; done: number; total: number }
    | { kind: 'ready'; result: VerifyResponse }
    | { kind: 'blocked'; result: VerifyResponse }
    | { kind: 'read-failed'; message: string }
}) {
  const running = state.kind === 'running'
  const result = state.kind === 'ready' || state.kind === 'blocked' ? state.result : null
  return (
    <StepCard
      number="02"
      title="Check the invoice"
      status={state.kind === 'ready' ? 'done' : state.kind === 'blocked' ? 'blocked' : state.kind === 'read-failed' ? 'error' : running ? 'active' : 'idle'}
      summary={
        result ? (
          <p aria-live="polite">
            {state.kind === 'ready'
              ? `All gating checks passed — ${result.passed} of ${result.total} checks passed; the other ${result.total - result.passed} ${result.total - result.passed === 1 ? 'is' : 'are'} information or not run. You can pay once.`
              : `Cannot pay yet: ${result.blocked_reason ?? 'a check failed.'}`}
          </p>
        ) : undefined
      }
    >
      <p className="text-[15px] text-muted">{COPY.step2Helper}</p>
      <div className="mt-4">
        <PrimaryButton onClick={onCheck} disabled={running} disabledReason={running ? 'Checking…' : null}>
          {running ? 'Checking…' : 'Check invoice'}
        </PrimaryButton>
      </div>
      {running ? (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading the chain… (check {state.done} of {state.total})
        </p>
      ) : null}
      {state.kind === 'read-failed' ? (
        <AlertInline>
          We could not read the testnet just now. Nothing was paid. Try again.
          <span className="ml-2">
            <button type="button" onClick={onCheck} className="font-medium text-brand-700 underline underline-offset-2">
              Retry
            </button>
          </span>
        </AlertInline>
      ) : null}
      {result ? (
        <div className="mt-4">
          <CheckList result={result} />
          <p className="mt-2 text-xs text-muted">
            Checked at {new Date(result.checked_at).toISOString().slice(11, 19)} UTC · {result.read_ms} ms
          </p>
        </div>
      ) : null}
    </StepCard>
  )
}
