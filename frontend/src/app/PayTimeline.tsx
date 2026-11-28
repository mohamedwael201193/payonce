// The payment, step by step, as the API reports it over the job stream. A
// step is "done" only when the API says so; a transaction hash appears the
// moment one is observed.
import { Loader2 } from 'lucide-react'
import { COPY } from '../lib/copy'
import type { JobSnapshot } from '../lib/types'
import { ExplorerTx, LayerLabel } from './ui'

const RAIL_A_STEPS = ['check_status', 'check_agent', 'submit', 'wait_finality', 'read_back', 'verify']
const RAIL_B_STEPS = ['check_wallet', 'reserve', 'co_sign_decide', 'submit_transfer', 'wait_finality', 'confirm', 'verify']

const STEP_LABELS: Record<string, string> = {
  check_status: 'Check the invoice status',
  check_agent: 'Check the seller agent',
  submit: 'Submit the payment',
  wait_finality: 'Wait for the chain to finalize',
  read_back: 'Read the payment back from the chain',
  verify: 'Run the verifier',
  check_wallet: 'Check the wallet',
  reserve: 'Reserve the invoice on chain',
  co_sign_decide: 'Policy gate decision',
  submit_transfer: 'Submit the transfer',
  confirm: 'Confirm the payment on chain',
}

const STATUS_WORD: Record<string, string> = {
  ok: 'Done',
  running: 'Running',
  retrying: 'Retrying',
  failed: 'Failed',
  refused: 'Refused',
  pending: 'Waiting',
}

export function PayTimeline({ job, explorerBase }: { job: JobSnapshot; explorerBase: string }) {
  const expected = job.rail === 'ccd' ? RAIL_A_STEPS : RAIL_B_STEPS
  const byId = new Map(job.steps.map((s) => [s.step, s]))
  return (
    <ol className="flex flex-col gap-3" aria-label="Payment steps" data-testid="pay-timeline">
      {expected.map((id) => {
        const s = byId.get(id)
        const status = s?.status ?? 'pending'
        return (
          <li key={id} className="flex items-start gap-3">
            <span className="mt-1 shrink-0" aria-hidden="true">
              {status === 'ok' ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-po-ok-bg text-[11px] font-bold text-po-ok">
                  ✓
                </span>
              ) : status === 'running' || status === 'retrying' ? (
                <Loader2 className="h-5 w-5 animate-spin text-po-accent-ink" />
              ) : status === 'failed' || status === 'refused' ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-po-bad-bg text-[11px] font-bold text-po-bad">
                  ✕
                </span>
              ) : (
                <span className="block h-5 w-5 rounded-full border border-po-line-strong" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium text-po-ink">{STEP_LABELS[id] ?? id}</p>
              {s?.detail ? <p className="text-sm text-po-grey">{s.detail}</p> : null}
              {status === 'retrying' ? <p className="text-sm text-po-grey">Retrying. The public test node is busy.</p> : null}
              {s?.txHash ? <ExplorerTx hash={s.txHash} base={explorerBase} /> : null}
            </div>
            <span className="shrink-0 text-xs font-semibold text-po-grey">{STATUS_WORD[status] ?? status}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function RefusalNotice({ job, explorerBase }: { job: JobSnapshot; explorerBase: string }) {
  const failed = job.steps.find((s) => s.status === 'refused' || s.status === 'failed')
  const reject = failed?.reject
  const layer = failed?.layer ?? 'chain'
  const fee = (failed as { fee_testnet_ccd?: string } | undefined)?.fee_testnet_ccd
  return (
    <div role="alert" className="rounded-[10px] border border-po-bad bg-po-bad-bg p-4 text-po-bad" data-testid="refusal">
      <div className="flex flex-wrap items-center gap-2">
        <LayerLabel layer={layer} />
        {reject ? (
          <span className="text-sm font-semibold">
            Code {reject.code}, {reject.name}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[15px]">
        {layer === 'chain'
          ? COPY.chainRefused(reject?.code ?? 0, reject?.name ?? 'Rejected', reject?.plain ?? 'The chain refused this payment.', fee ?? null)
          : layer === 'co_signer'
            ? COPY.coSignerRefused(failed?.detail ?? 'The policy gate refused this transfer.')
            : COPY.appRefused(failed?.detail ?? 'This app refused the payment.')}
      </p>
      {failed?.txHash ? (
        <p className="mt-1">
          <ExplorerTx hash={failed.txHash} base={explorerBase} />
        </p>
      ) : (
        <p className="mt-1 text-sm">No transaction was sent.</p>
      )}
    </div>
  )
}
