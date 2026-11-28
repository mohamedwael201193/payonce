// Four PayOnce agents on the official CIS-8004 registry. "Verified by Concordium"
// and "15/15" are printed only from a live badge-check that returned badge_valid true.
import { useEffect } from 'react'
import { AGENTS, OFFICIAL_REGISTRY, badgeCheckUrl, badgeResultText, useBadgeCheck, type AgentIdentity } from './identity'
import './officialBadges.css'

function useLiveBadge(badge: string) {
  const { result, check } = useBadgeCheck(badge)
  useEffect(() => { void check() }, [check])
  return result
}

function Card({ agent }: { agent: AgentIdentity }) {
  const result = useLiveBadge(agent.badge)
  const text = badgeResultText(result) || 'Asking the official registry'
  const tone = result.state === 'valid' ? 'ok' : result.state === 'idle' || result.state === 'checking' ? 'idle' : 'bad'
  const score = result.state === 'valid' || result.state === 'invalid' ? `${result.passed}/${result.total}` : null
  return (
    <li className={`ob-card ob-card--${tone}`} data-testid="official-badge">
      <p className="ob-role">{agent.role}</p>
      <p className="ob-name">{agent.name} <b>#{agent.token}</b></p>
      {result.state === 'valid' && score ? <p className="ob-score" data-testid="official-badge-score">{score}</p> : null}
      <p className={`ob-res ob-res--${tone}`} role="status">{text}</p>
      <p className="ob-links">
        <a href={badgeCheckUrl(agent.badge)} target="_blank" rel="noreferrer">Official check</a>
        <a href={agent.card} target="_blank" rel="noreferrer">Agent card</a>
      </p>
    </li>
  )
}

export function OfficialBadges({ title = 'Four official badges, checked live' }: { title?: string }) {
  return (
    <section className="ob" aria-label="Official Concordium agent badges" data-testid="official-badges">
      <h2 className="ob-h">{title}</h2>
      <p className="ob-lead">
        Four agents on Concordium’s official CIS-8004 registry {`<${OFFICIAL_REGISTRY.index},${OFFICIAL_REGISTRY.subindex}>`}, testnet.
        Each line is a live check from this browser. The official label is printed only when the registry returns badge_valid true.
      </p>
      <ul className="ob-grid">
        {AGENTS.map((a) => (
          <Card key={a.key} agent={a} />
        ))}
      </ul>
    </section>
  )
}
