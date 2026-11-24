// BudgetNote — P3 §5. Says how many fresh invoices and attack sends remain
// this hour, from /api/health. States: available, used up. Unknown values
// show "—" (P3 §2 rule 9), never a fallback number.
import { useHealth } from '../hooks/useApi'

export function BudgetNote({ showFresh = true, showAttacks = true }: { showFresh?: boolean; showAttacks?: boolean }) {
  const health = useHealth()
  const fresh = health.data?.budget.new_invoices_left_this_hour ?? null
  const attacks = health.data?.budget.attack_sends_left_this_hour ?? null

  if (health.isLoading || (!health.data && !health.isError)) {
    return <p className="text-xs text-muted">Budget this hour: loading…</p>
  }
  if (health.isError || !health.data) {
    return <p className="text-xs text-muted">Budget this hour: — (the testnet is not answering).</p>
  }
  const parts: string[] = []
  if (showFresh) {
    parts.push(fresh === 0 ? 'fresh invoices: used up for this hour' : `${fresh} fresh invoice${fresh === 1 ? '' : 's'} left`)
  }
  if (showAttacks) {
    parts.push(
      attacks === 0 ? 'attack sends: used up for this hour' : `${attacks} attack send${attacks === 1 ? '' : 's'} left`,
    )
  }
  return <p className="text-xs text-muted">Budget this hour: {parts.join(', ')}.</p>
}
