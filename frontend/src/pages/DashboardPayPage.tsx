// Pay page — /dashboard/pay. The dashboard shell (same Sidebar +
// <main> as the overview) with the pay flow as its main content. The
// flow lives here as MANUAL tabs (fix-back-12): one tab per step (pick /
// check / pay / receipt) plus Try to break it, clicked by the user, never
// auto-rotating or auto-advancing. Tab state is the URL query ?tab=
// (pick|check|pay|receipt|try; anything else falls back to pick), so a
// tab is deep-linkable and survives reloads; ?payable= is preserved.
import { Link } from 'react-router-dom'
import { DashboardShell } from '../components/DashboardShell'
import { PayFlowTabs } from '../components/PayFlowTabs'

export function DashboardPayPage() {
  return (
    <DashboardShell>
      <PayFlowTabs />
      <p className="mt-8 text-sm text-muted">
        <Link to="/dashboard" className="font-medium text-brand-700">
          ← Dashboard overview
        </Link>{' '}
        · <Link to="/judges" className="font-medium text-brand-700">For judges →</Link>
      </p>
    </DashboardShell>
  )
}
