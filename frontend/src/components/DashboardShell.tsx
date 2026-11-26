// Dashboard shell — the shared chrome for /dashboard (overview) and
// /dashboard/pay (pay flow): Sidebar + <main id="main">. Extracted from
// DashboardPage (2026-11-26, pay-route fix) so both pages share one
// chrome — no duplicated sidebar, one chrome per breakpoint.
//
// ACTIVE PILL: "Dashboard" and "Pay an invoice" are distinct pathnames
// now (/dashboard vs /dashboard/pay), so the active state keys off the
// pathname — exactly one pill active at a time. Home / For judges keep
// NavLink (distinct pathnames).
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Home, LayoutDashboard, Receipt, Wallet } from 'lucide-react'
import { COPY } from '../lib/copy'
import { Logo } from './Logo'

const NAV = [
  { to: '/', label: 'Home', icon: Home, kind: 'route' as const, end: true },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, kind: 'route' as const, end: true },
  // The pay flow is its own route now (/dashboard/pay) — the sidebar
  // link goes there, never to a #pay anchor below the overview content
  // (the 2026-11-26 scroll-yank bug).
  { to: '/dashboard/pay?tab=pick', label: 'Pay an invoice', icon: Wallet, kind: 'pay' as const },
  { to: '/judges', label: 'For judges', icon: Receipt, kind: 'route' as const, end: false },
]

function Sidebar() {
  const { pathname } = useLocation()
  const payView = pathname === '/dashboard/pay' || pathname.startsWith('/dashboard/pay/')
  const overviewView = pathname === '/dashboard'
  const itemClass = (active: boolean) =>
    `flex shrink-0 items-center gap-3 rounded-full px-4 py-2.5 text-[15px] font-medium whitespace-nowrap transition-colors ${
      active ? 'bg-white/20 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]' : 'text-white/85 hover:bg-white/10 hover:text-white'
    }`
  return (
    <aside className="shrink-0 bg-gradient-to-b from-sky-0 via-sky-1 to-sky-2 text-white lg:flex lg:min-h-screen lg:w-[260px] lg:flex-col">
      <div className="flex items-center gap-3 px-5 pt-5 pb-6 lg:px-6 lg:pt-8">
        <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home">
          <Logo dark size={32} />
        </Link>
        <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em]">
          {COPY.testnetBadge}
        </span>
      </div>
      <nav aria-label="Dashboard" className="flex gap-2 overflow-x-auto px-4 pb-4 lg:flex-col lg:gap-1.5 lg:overflow-visible lg:px-4 lg:pb-0">
        {NAV.map((n) => {
          if (n.kind === 'pay') {
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={payView ? 'page' : undefined}
                className={itemClass(payView)}
              >
                <n.icon className="h-5 w-5" aria-hidden="true" />
                {n.label}
              </Link>
            )
          }
          if (n.to === '/dashboard') {
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={overviewView ? 'page' : undefined}
                className={itemClass(overviewView)}
              >
                <n.icon className="h-5 w-5" aria-hidden="true" />
                {n.label}
              </Link>
            )
          }
          return (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => itemClass(isActive)}>
              <n.icon className="h-5 w-5" aria-hidden="true" />
              {n.label}
            </NavLink>
          )
        })}
      </nav>
      {/* Sidebar art — the bottom of the sidebar was a long empty brown
          gradient (user's mobile/desktop screenshot). A hairline sunset
          scene in cream strokes, drawn for this sidebar: the sun over the
          hills, and a receipt slip rising from the middle hill. Decorative
          only (aria-hidden), pinned to the bottom with mt-auto, desktop
          only — on phones the sidebar is a horizontal strip and the art
          stays out of it. */}
      <div className="mt-auto hidden lg:block" aria-hidden="true">
        <svg viewBox="0 0 260 150" className="w-full text-white/50" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
          <circle cx="130" cy="46" r="17" />
          <path d="M 130 22 v -7 M 130 77 v -7 M 106 46 h -7 M 161 46 h -7" opacity="0.7" />
          <path d="M 0 96 C 50 78, 90 108, 130 92 S 215 74, 260 96" opacity="0.8" />
          <path d="M 0 114 C 55 96, 100 124, 150 110 S 220 98, 260 116" opacity="0.55" />
          <path d="M 0 132 C 60 116, 110 140, 165 126 S 230 118, 260 132" opacity="0.35" />
          <rect x="118" y="58" width="24" height="30" rx="2" />
          <path d="M 123 66 h 14 M 123 72 h 14 M 123 78 h 9" opacity="0.8" />
          <path d="M 124 84 l 3 3 l 5 -6" />
        </svg>
        <p className="px-6 pt-2 pb-6 text-xs leading-relaxed text-white/70">
          Testnet · Concordium
          <br />
          Every number on this page is live from the test registry.
        </p>
      </div>
    </aside>
  )
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="page-enter min-h-screen bg-paper lg:flex">
      <Sidebar />
      <main id="main" className="min-w-0 flex-1 px-4 py-8 sm:px-8 sm:py-10">
        {children}
      </main>
    </div>
  )
}
