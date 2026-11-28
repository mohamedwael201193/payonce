// x402 settle receipt: the recorded run in which the hosted Concordium x402 facilitator verified a
// payment and the chain settled it. The file is committed evidence (backend/test/x402-hosted-settle-2026-11-26.json),
// labelled RECORDED. The hosted /settle answered "not found" while the chain confirmed the transfer, and this
// page says so. Nothing here is fetched live except the explorer links.
import { useQuery } from '@tanstack/react-query'
import { Address } from '../Address'
import { useDocumentTitle } from '../hooks'
import { verifierCommand } from '../verifier'
import { Card, CopyButton, ExplorerTx, KeyValue, Notice, PageHeader, Skeleton, StatusPill } from '../ui'

interface Settle {
  generated_at: string
  facilitator: string
  asset: string
  amount_display: string
  steps: {
    verify: { isValid: boolean; payer: string; binding_checks: Array<{ name: string; ok: boolean; detail: string }> }
    settle: { success: boolean; transaction: string; errorReason: string | null }
    settle_readback: { confirmed: boolean; status: string; blockHash: string }
    settle_tx_on_chain: { status: string; sender: string; type: string; events: Array<{ tag: string; tokenId: string; from: string; to: string; amount: string }> }
    keyless_verifier: { ok: boolean; summary: string; lines: string[] }
  }
  payable: { seller: string; id: number; payee: string; payer: string; register_tx: string; reserve_tx: string; confirm_tx: string; status_after: string }
}

export const X402_EVIDENCE_URL = '/evidence/x402-hosted-settle-2026-11-26.json'

export function X402Page() {
  useDocumentTitle('x402 receipt - PayOnce')
  const q = useQuery({
    queryKey: ['x402-evidence'],
    staleTime: 60 * 60_000,
    retry: 1,
    queryFn: async (): Promise<Settle> => {
      const res = await fetch(X402_EVIDENCE_URL, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as Settle
    },
  })
  const d = q.data
  const cmd = d
    ? verifierCommand({
        payableId: d.payable.id,
        txHash: d.steps.settle.transaction,
        reserveTx: d.payable.reserve_tx,
        confirmTx: d.payable.confirm_tx,
      })
    : ''
  const transfer = d?.steps.settle_tx_on_chain.events.find((e) => e.tag === 'TokenTransfer')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="x402 settle receipt"
        lead="One payment of an invoice by x402: the payer signed an EUDemo transfer, the hosted Concordium facilitator verified it against the PayOnce rules, and the chain settled it. Recorded run, testnet only."
        actions={<StatusPill tone="neutral">Recorded 26 Nov 2026</StatusPill>}
      />

      {q.isLoading ? (
        <Skeleton className="h-[260px] w-full" />
      ) : q.isError || !d ? (
        <Notice tone="warn">The recorded settle file could not be loaded from this site.</Notice>
      ) : (
        <>
          <Card className="flex flex-col gap-4" aria-labelledby="x402-summary">
            <h2 id="x402-summary" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
              What was paid
            </h2>
            <dl className="divide-y divide-po-line">
              <KeyValue label="Amount">{d.amount_display} (testnet demo token, not a euro stablecoin)</KeyValue>
              <KeyValue label="Invoice">payable {d.payable.id}, status after: {d.payable.status_after}</KeyValue>
              <KeyValue label="Payer"><Address value={d.payable.payer} kind="account" label="payer" /></KeyValue>
              <KeyValue label="Payee on chain"><Address value={d.payable.payee} kind="account" label="payee" /></KeyValue>
              <KeyValue label="Seller (agent token 1476)"><Address value={d.payable.seller} kind="account" label="seller" /></KeyValue>
              <KeyValue label="Facilitator">
                <a href={d.facilitator} target="_blank" rel="noreferrer" className="font-medium text-po-accent-ink underline decoration-po-line-strong">{d.facilitator}</a>
              </KeyValue>
            </dl>
          </Card>

          <Card className="flex flex-col gap-4" aria-labelledby="x402-tx">
            <h2 id="x402-tx" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
              Transactions
            </h2>
            <dl className="divide-y divide-po-line">
              <KeyValue label="Register payable"><ExplorerTx hash={d.payable.register_tx} /></KeyValue>
              <KeyValue label="Reserve by the payer"><ExplorerTx hash={d.payable.reserve_tx} /></KeyValue>
              <KeyValue label="x402 settle (EUDemo transfer)"><ExplorerTx hash={d.steps.settle.transaction} /></KeyValue>
              <KeyValue label="Confirm by the payer"><ExplorerTx hash={d.payable.confirm_tx} /></KeyValue>
              <KeyValue label="Read from the chain">
                {d.steps.settle_tx_on_chain.type} {d.steps.settle_tx_on_chain.status}
                {transfer ? `: ${transfer.tag} of ${transfer.tokenId}, ${(Number(transfer.amount) / 1e6).toFixed(2)} from the payer to the payee` : ''}. Block{' '}
                <Address value={d.steps.settle_readback.blockHash} kind="hash" label="block hash" explorer={false} />
              </KeyValue>
            </dl>
          </Card>

          <Card className="flex flex-col gap-4" aria-labelledby="x402-verify">
            <h2 id="x402-verify" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
              The facilitator and the PayOnce rules
            </h2>
            <p className="text-[15px] text-po-grey">
              The hosted facilitator&apos;s verify answered isValid {String(d.steps.verify.isValid)}. PayOnce then bound the payment to the invoice with these checks:
            </p>
            <ul className="divide-y divide-po-line" data-testid="x402-binding">
              {d.steps.verify.binding_checks.map((c) => (
                <li key={c.name} className="grid gap-1 py-2 sm:grid-cols-[220px_1fr] sm:gap-4">
                  <span className="flex items-center gap-2 text-[15px] font-medium text-po-ink">
                    <StatusPill tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'Pass' : 'Fail'}</StatusPill>
                    {c.name}
                  </span>
                  <span className="min-w-0 break-words text-[15px] text-po-grey">{c.detail}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex flex-col gap-4" aria-labelledby="x402-honest">
            <h2 id="x402-honest" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
              What the hosted facilitator got wrong
            </h2>
            <Notice tone="warn">
              The hosted /settle answered success false with the reason &ldquo;{d.steps.settle.errorReason}&rdquo; while the transfer was already finalized on chain
              {d.steps.settle_readback.confirmed ? ' (our read-back confirmed it)' : ''}. We did not hide that: the settle result is the facilitator&apos;s, the proof is the chain.
            </Notice>
            <p className="text-[15px] text-po-grey">
              So this receipt trusts the transaction, not the facilitator&apos;s answer. The verifier below re-reads the registry, the badge and the transfer from the chain.
            </p>
          </Card>

          <Card className="flex flex-col gap-4" aria-labelledby="x402-verifier">
            <h2 id="x402-verifier" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
              Verifier result: {d.steps.keyless_verifier.summary}
            </h2>
            <ul className="divide-y divide-po-line" data-testid="x402-verifier-lines">
              {d.steps.keyless_verifier.lines
                .filter((l) => /^(PASS|FAIL|SKIP)/.test(l))
                .map((l) => (
                  <li key={l.slice(0, 60)} className="py-2 font-mono text-[13px] break-words text-po-ink">
                    {l}
                  </li>
                ))}
            </ul>
            <p className="text-[15px] text-po-grey">
              The recorded run had the invoice file, so its document check passed (14 of 14). That test file was not kept in the repo, so a fresh run prints <code className="po-hash">ALL RUNNABLE CHECKS PASS (13/14)</code> with the document check reported as not run, never as passed. Run it yourself (read-only, no keys):
            </p>
            <pre className="overflow-x-auto rounded-[10px] bg-po-ink p-4 font-mono text-[13px] leading-relaxed text-po-white">{`cd api && npm ci && cd ../backend && npm ci && cd ../api\n${cmd}`}</pre>
            <div>
              <CopyButton value={cmd} label="verifier command" />
            </div>
            <p className="text-[15px] text-po-grey">
              The raw record is <a className="font-medium text-po-accent-ink underline decoration-po-line-strong" href={X402_EVIDENCE_URL}>x402-hosted-settle-2026-11-26.json</a>. It was produced by the run in <code className="po-hash">qa/x402-settle-live.mjs</code>.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
