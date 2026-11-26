// The verifier's check list. Every row says what was checked, what came
// back, and which layer did the checking. A check that did not run is shown
// as not run, never as a pass.
import { CircleDashed, CircleX, Info, CircleCheck } from 'lucide-react'
import type { CheckRow, VerifyResponse } from '../lib/types'
import { LayerLabel, Skeleton } from './ui'

function Icon({ status }: { status: CheckRow['status'] }) {
  switch (status) {
    case 'ok':
      return <CircleCheck className="h-5 w-5 text-po-ok" aria-hidden="true" />
    case 'fail':
      return <CircleX className="h-5 w-5 text-po-bad" aria-hidden="true" />
    case 'info':
      return <Info className="h-5 w-5 text-po-grey" aria-hidden="true" />
    default:
      return <CircleDashed className="h-5 w-5 text-po-grey" aria-hidden="true" />
  }
}

/** Why a check blocked payment, in words: the failing check, not the bare code. */
export function blockedText(result: VerifyResponse): string {
  const f = result.checks.find((x) => x.status === 'fail')
  if (f) return `${f.label}: ${f.detail}`
  return result.blocked_reason ?? 'a check failed.'
}

const WORD: Record<CheckRow['status'], string> = { ok: 'Passed', fail: 'Failed', info: 'Info', not_run: 'Not run' }

export function CheckRows({ result }: { result: VerifyResponse }) {
  return (
    <ul className="divide-y divide-po-line rounded-[10px] border border-po-line bg-po-surface" aria-label="Checks">
      {result.checks.map((c) => (
        <li key={c.id} className="flex items-start gap-3 px-4 py-3" data-testid="check-row">
          <span className="mt-0.5 shrink-0">
            <Icon status={c.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-po-ink">{c.label}</p>
            <p className="text-sm break-words text-po-grey [overflow-wrap:anywhere]">{c.detail}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span
              className={`text-xs font-semibold ${c.status === 'ok' ? 'text-po-ok' : c.status === 'fail' ? 'text-po-bad' : 'text-po-grey'}`}
            >
              {WORD[c.status]}
            </span>
            <LayerLabel layer={c.layer} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CheckRowsSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-po-line bg-po-surface p-4" role="status" aria-label="Reading the chain">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}
