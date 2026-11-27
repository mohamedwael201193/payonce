import { Count, Tag } from './bits'
import { formatDay, formatStamp, headline, type LandingData } from './data'

/** Section 2: four counters from the live API (or the dated snapshot). */
export function Strip({ data }: { data: LandingData }) {
  const { stats, source, at, snapshot } = data
  const h = headline(stats)
  const v = snapshot.verify
  return (
    <section className="po-strip" aria-label="Testnet numbers">
      <div className="po-wrap">
        <ul className="po-strip__grid">
          <li>
            <Count to={h.total} className="po-strip__n" />
            <span className="po-strip__l">
              {h.split ? `Demo invoices on the testnet registry (${h.allTotal} payables in all)` : 'Payables on the testnet registry'}
            </span>
          </li>
          <li>
            <Count to={h.paid} className="po-strip__n" />
            <span className="po-strip__l">Paid exactly once, {h.pct}% of {h.split ? 'the demo invoices' : 'the total'}</span>
          </li>
          <li>
            <Count to={stats.refused_on_chain_since_deploy} className="po-strip__n" />
            <span className="po-strip__l">Payments the chain refused since the API last deployed</span>
          </li>
          {v && (
            <li>
              <span className="po-strip__n">
                <Count to={v.passed} />
                <small>/{v.total}</small>
              </span>
              <span className="po-strip__l">
                Verifier checks passed on payable {v.payable_id}, <Tag kind="recorded">Recorded {formatDay(v.checked_at)}</Tag>
              </span>
            </li>
          )}
        </ul>
        <p className="po-strip__note">
          {source === 'live' ? <Tag kind="live">Live, {formatStamp(at)}</Tag> : <Tag kind="recorded">Recorded snapshot, {formatStamp(at)}</Tag>}
          <span>
            Testnet only. {h.split ? `${h.testTotal} more payables on the registry are our own automated test runs (${h.testPaid} paid); they are counted apart. ` : 'These counts include our own test runs and attack attempts. '}No count here says anything about real
            usage. Refusals are counted from the API log, because a refused transaction leaves no chain state.
          </span>
        </p>
      </div>
    </section>
  )
}
