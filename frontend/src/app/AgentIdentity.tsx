// Agent identity, shown with proof: each PayOnce agent's badge on the OFFICIAL registry, a live
// "Check badge" button (the registry's own endpoint, called from this browser), the agent card, and the
// accountable-human record behind the sellers. Nothing says "Verified by Concordium" before a live check
// returned badge_valid true.
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { Address } from './Address'
import { AGENTS, OFFICIAL_REGISTRY, badgeCheckUrl, badgeResultText, useBadgeCheck, type AgentIdentity } from './identity'
import { Button, Card, ExplorerTx, Notice, StatusPill } from './ui'

export function AgentBadgeCard({ agent }: { agent: AgentIdentity }) {
  const { result, check } = useBadgeCheck(agent.badge)
  const text = badgeResultText(result)
  return (
    <Card as="div" className="flex h-full flex-col gap-3" data-testid="agent-badge-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.01em] text-po-ink">{agent.name}</h3>
          <p className="text-sm text-po-grey">
            {agent.role} agent, token <span className="po-num font-semibold text-po-ink">{agent.token}</span> on the official registry &lt;{OFFICIAL_REGISTRY.index},{OFFICIAL_REGISTRY.subindex}&gt;
          </p>
        </div>
        {result.state === 'valid' ? (
          <StatusPill tone="ok">Verified by Concordium</StatusPill>
        ) : result.state === 'invalid' ? (
          <StatusPill tone="bad">Badge not valid</StatusPill>
        ) : result.state === 'error' ? (
          <StatusPill tone="warn">Check unavailable</StatusPill>
        ) : (
          <StatusPill tone="neutral">Not checked yet</StatusPill>
        )}
      </div>
      <dl className="grid gap-2 text-[15px]">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Owner account</dt>
          <dd className="min-w-0">
            <Address value={agent.owner} kind="account" label={`${agent.name} owner account`} />
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Badge address</dt>
          <dd className="min-w-0">
            <Address value={agent.badge} kind="hash" label={`${agent.name} badge address`} explorer={false} />
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">agentWallet, signed by that wallet</dt>
          <dd className="min-w-0">
            <ExplorerTx hash={agent.walletTx} />
          </dd>
        </div>
      </dl>
      <p className="min-h-[24px] text-[15px] text-po-ink" role="status" aria-live="polite" data-testid="badge-result">
        {text}
      </p>
      <div className="po-btn-row mt-auto">
        <Button small variant="secondary" onClick={() => void check()} busy={result.state === 'checking'}>
          Check badge
        </Button>
        <a href={agent.card} target="_blank" rel="noreferrer" className="po-btn po-btn-ghost po-btn-sm">
          Agent card
        </a>
        <a href={badgeCheckUrl(agent.badge)} target="_blank" rel="noreferrer" className="po-btn po-btn-ghost po-btn-sm">
          Raw check
        </a>
      </div>
    </Card>
  )
}

export function AgentBadges() {
  return (
    <ul className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="PayOnce agents on the official registry">
      {AGENTS.map((a) => (
        <li key={a.key} className="h-full">
          <AgentBadgeCard agent={a} />
        </li>
      ))}
    </ul>
  )
}

// ---- accountable human (owner proof) ----

export interface OwnerProofDoc {
  title: string
  network: string
  produced: string
  holderAccount: string
  proves: string[]
  anchors: { vra: string; vaa: string }
  honest: string[]
  verifyCommand: string
  behind: { sellerAgentToken: number }
}

export function useOwnerProof() {
  return useQuery({
    queryKey: ['owner-proof'],
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<OwnerProofDoc> => {
      const res = await fetch('/proofs/owner-proof.json', { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as OwnerProofDoc
    },
  })
}

/** Compact line for a seller card: whether this seller's owner has a published proof. */
export function OwnerProofLine({ seller }: { seller: string }) {
  const q = useOwnerProof()
  if (q.isLoading) return null
  if (q.isError || !q.data || q.data.holderAccount !== seller) {
    return <p className="text-sm text-po-grey" data-testid="owner-proof-line">No owner proof is published for this seller account.</p>
  }
  return (
    <p className="text-sm text-po-ink" data-testid="owner-proof-line">
      Accountable human: owner proof 18+ and EU, anchored on chain (VRA <ExplorerTx hash={q.data.anchors.vra} label={q.data.anchors.vra.slice(0, 8)} />, VAA{' '}
      <ExplorerTx hash={q.data.anchors.vaa} label={q.data.anchors.vaa.slice(0, 8)} />). Testnet identity provider.
    </p>
  )
}

export function OwnerProofPanel() {
  const q = useOwnerProof()
  if (q.isLoading) return <p className="text-[15px] text-po-grey">Reading the published proof.</p>
  if (q.isError || !q.data) return <Notice tone="warn">The owner proof record could not be loaded from this site.</Notice>
  const d = q.data
  return (
    <div className="flex flex-col gap-3" data-testid="owner-proof-panel">
      <p className="flex items-center gap-2 text-[15px] text-po-ink">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        Owner of seller agent token {d.behind.sellerAgentToken}: {d.proves.join('; ')}.
      </p>
      <dl className="grid gap-2 text-[15px]">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Owner account</dt>
          <dd><Address value={d.holderAccount} kind="account" label="owner account" /></dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Request anchor (VRA)</dt>
          <dd><ExplorerTx hash={d.anchors.vra} /></dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Audit anchor (VAA)</dt>
          <dd><ExplorerTx hash={d.anchors.vaa} /></dd>
        </div>
      </dl>
      <p className="text-[15px] text-po-grey">
        Re-check it without us (reads the public testnet node, no keys):
      </p>
      <pre className="overflow-x-auto rounded-[10px] bg-po-ink p-4 font-mono text-[13px] leading-relaxed text-po-white">{`cd backend && npm ci\nnode scripts/verify-owner-proof.mjs https://payonce-tau.vercel.app/proofs/owner-proof.json`}</pre>
      <p className="text-[15px] text-po-grey">
        The record is <a className="font-medium text-po-accent-ink underline decoration-po-line-strong" href="/proofs/owner-proof.json">/proofs/owner-proof.json</a>. Honest limits:
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[15px] text-po-grey">
        {d.honest.map((h) => (
          <li key={h.slice(0, 30)}>{h}</li>
        ))}
      </ul>
    </div>
  )
}
