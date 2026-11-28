// Agent identity on the OFFICIAL Concordium agent registry (CIS-8004 <12802,0>, testnet).
// The three PayOnce agents, the badge addresses the registry knows them by, and the live badge check.
// "Verified by Concordium" is only ever printed from a live check that returned badge_valid: true.
import { useCallback, useState } from 'react'

export const REGISTRY_MCP = 'https://agent-registry-mcp.concordium.com'
export const OFFICIAL_REGISTRY = { index: 12802, subindex: 0 }
export const SITE = 'https://payonce-tau.vercel.app'

export interface AgentIdentity {
  key: 'seller1' | 'seller2' | 'buyer'
  role: 'Seller' | 'Payer'
  name: string
  token: number
  /** The registry's badge (token) address, base58. */
  badge: string
  /** Account that owns the agent token (full address). */
  owner: string
  card: string
}

export const AGENTS: AgentIdentity[] = [
  {
    key: 'seller1',
    role: 'Seller',
    name: 'PayOnce Seller',
    token: 1476,
    badge: 'JyP9XawpXHMjTN5ocrA5a',
    owner: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
    card: `${SITE}/.well-known/agent-card.json`,
  },
  {
    key: 'seller2',
    role: 'Seller',
    name: 'PayOnce Seller 2',
    token: 1506,
    badge: 'JyP9Y9nGU4KaM7DBDXRgm',
    owner: '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr',
    // On chain, token 1506's agent_uri is this gist (the badge is valid for it), not the site copy.
    card: 'https://gist.githubusercontent.com/mohamedwael201193/27ff98d204920b196089c76fcf208406/raw/agent-card-seller2.json',
  },
  {
    key: 'buyer',
    role: 'Payer',
    name: 'PayOnce Buyer',
    token: 1488,
    badge: 'JyP9Xp5bhbLsQrw7yTyph',
    owner: '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs',
    card: `${SITE}/.well-known/agent-card-buyer.json`,
  },
]

export const badgeCheckUrl = (badge: string) => `${REGISTRY_MCP}/v1/badge-check/${badge}?network=testnet`

export type BadgeCheckResult =
  | { state: 'valid'; passed: number; total: number; status: string; agentUri: string | null }
  | { state: 'invalid'; passed: number; total: number; status: string; agentUri: string | null; issues: string[] }
  | { state: 'error'; message: string }

/** Read the registry's badge-check body. valid only when badge_valid is exactly true. */
export function parseBadgeCheck(body: unknown): BadgeCheckResult {
  const b = body as {
    badge_valid?: unknown
    checks?: Record<string, unknown>
    on_chain?: { status?: unknown; agent_uri?: unknown }
    issues?: Array<{ message?: unknown }>
  } | null
  if (!b || typeof b !== 'object' || typeof b.badge_valid !== 'boolean') {
    return { state: 'error', message: 'The registry answered with something this page cannot read.' }
  }
  const entries = Object.values(b.checks ?? {})
  // The registry's checks are booleans, plus badge_embedding, which names how the badge is embedded ("extension").
  const passed = entries.filter((v) => v === true || (typeof v === 'string' && v !== '' && v !== 'none')).length
  const total = entries.length
  const status = typeof b.on_chain?.status === 'string' ? b.on_chain.status : 'unknown'
  const agentUri = typeof b.on_chain?.agent_uri === 'string' ? b.on_chain.agent_uri : null
  if (b.badge_valid === true) return { state: 'valid', passed, total, status, agentUri }
  const issues = (b.issues ?? []).map((i) => String(i?.message ?? '')).filter(Boolean)
  return { state: 'invalid', passed, total, status, agentUri, issues }
}

export type CheckState = { state: 'idle' } | { state: 'checking' } | BadgeCheckResult

/** A manual check: nothing is called until check() runs, so the page never prints a result it did not fetch. */
export function useBadgeCheck(badge: string, fetchImpl: typeof fetch = fetch) {
  const [result, setResult] = useState<CheckState>({ state: 'idle' })
  const check = useCallback(async () => {
    setResult({ state: 'checking' })
    try {
      const res = await fetchImpl(badgeCheckUrl(badge), { headers: { accept: 'application/json' } })
      const body = (await res.json().catch(() => null)) as unknown
      setResult(res.ok || body ? parseBadgeCheck(body) : { state: 'error', message: `The registry answered ${res.status}.` })
    } catch {
      setResult({ state: 'error', message: 'The registry could not be reached from this browser.' })
    }
  }, [badge, fetchImpl])
  return { result, check }
}

/** One line for a result, shared by the landing and the app. */
export function badgeResultText(r: CheckState): string {
  switch (r.state) {
    case 'idle':
      return ''
    case 'checking':
      return 'Asking the official registry'
    case 'valid':
      return `Verified by Concordium: badge_valid true, ${r.passed}/${r.total} checks, status ${r.status}`
    case 'invalid':
      return `Not verified: badge_valid false, ${r.passed}/${r.total} checks${r.issues[0] ? `. ${r.issues[0]}` : ''}`
    case 'error':
      return r.message
  }
}
