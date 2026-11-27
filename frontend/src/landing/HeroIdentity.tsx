// The three PayOnce agents on the OFFICIAL Concordium agent registry, on the first screen. Each has a live
// "Check badge" button that calls the registry's own endpoint from the visitor's browser. The label
// "Verified by Concordium" only appears from a result that returned badge_valid true.
import { Link } from 'react-router-dom'
import { AGENTS, OFFICIAL_REGISTRY, badgeResultText, useBadgeCheck, type AgentIdentity } from '../app/identity'

function Item({ agent }: { agent: AgentIdentity }) {
  const { result, check } = useBadgeCheck(agent.badge)
  const text = badgeResultText(result)
  const tone = result.state === 'valid' ? 'ok' : result.state === 'idle' || result.state === 'checking' ? 'idle' : 'bad'
  return (
    <li className="po-ident__item" data-testid="hero-agent">
      <div className="po-ident__top">
        <span className="po-ident__name">
          {agent.role} agent <b>#{agent.token}</b>
        </span>
        <button type="button" className="po-ident__btn" onClick={() => void check()} aria-busy={result.state === 'checking'}>
          Check badge
        </button>
        <a className="po-ident__link" href={agent.card} target="_blank" rel="noreferrer">
          Agent card
        </a>
      </div>
      <p className={`po-ident__res po-ident__res--${tone}`} role="status" aria-live="polite">
        {text || `Official registry <${OFFICIAL_REGISTRY.index},${OFFICIAL_REGISTRY.subindex}>, testnet`}
      </p>
    </li>
  )
}

export function HeroIdentity() {
  return (
    <section className="po-ident" aria-label="PayOnce agents on the official Concordium registry" data-testid="hero-identity">
      <ul className="po-ident__list">
        {AGENTS.map((a) => (
          <Item key={a.key} agent={a} />
        ))}
      </ul>
      <p className="po-ident__note">
        Badges on the official agent registry. Press Check badge to ask it now.{' '}
        <Link to="/app/judges#identity">Owner proof and trust model</Link>
      </p>
    </section>
  )
}
