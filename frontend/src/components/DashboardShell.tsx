// Dashboard shell — the shared chrome for /dashboard (overview) and
// /dashboard/pay (pay flow): Sidebar + <main id="main">. Extracted from
// DashboardPage (2026-11-26, pay-route fix) so both pages share one
// chrome — no duplicated sidebar, one chrome per breakpoint.
//
// ACTIVE PILL: "Dashboard" and "Pay an invoice" are distinct pathnames
// now (/dashboard vs /dashboard/pay), so the active state keys off the
// pathname — exactly one pill active at a time. Home / For judges /
// Verify age keep NavLink (distinct pathnames).
//
// ONE CHROME PER BREAKPOINT (SKILL.md §7 #1): desktop ≥1024px gets the
// full sidebar, tablet 768–1023px gets a 76px icon rail, mobile <768px
// gets a sticky top header + a fixed 5-slot bottom tab bar. Only the
// active breakpoint's chrome renders — `data-testid`s never duplicate.
// The breakpoint hook falls back to desktop when matchMedia is missing
// or no query matches (jsdom, stubbed matchMedia in tests).
import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Home, LayoutDashboard, Receipt, ShieldCheck, Wallet } from 'lucide-react'
import { useInvoices, useStats } from '../hooks/useApi'
import { formatUtcTime } from '../lib/format'
import { COPY } from '../lib/copy'
import { Logo } from './Logo'

type Breakpoint = 'desktop' | 'tablet' | 'mobile'

function useBreakpoint(): Breakpoint {
  const read = (): Breakpoint => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop'
    if (window.matchMedia('(min-width: 1024px)').matches) return 'desktop'
    if (window.matchMedia('(min-width: 768px) and (max-width: 1023px)').matches) return 'tablet'
    if (window.matchMedia('(max-width: 767px)').matches) return 'mobile'
    return 'desktop'
  }
  const [bp, setBp] = useState<Breakpoint>(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const update = () => setBp(read())
    const queries = [
      window.matchMedia('(min-width: 1024px)'),
      window.matchMedia('(min-width: 768px) and (max-width: 1023px)'),
      window.matchMedia('(max-width: 767px)'),
    ]
    queries.forEach((q) => q.addEventListener?.('change', update))
    return () => queries.forEach((q) => q.removeEventListener?.('change', update))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return bp
}

const NAV = [
  { to: '/', label: 'Home', icon: Home, kind: 'route' as const, end: true },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, kind: 'route' as const, end: true },
  // The pay flow is its own route now (/dashboard/pay) — the sidebar
  // link goes there, never to a #pay anchor below the overview content
  // (the 2026-11-26 scroll-yank bug).
  { to: '/dashboard/pay?tab=pick', label: 'Pay an invoice', icon: Wallet, kind: 'pay' as const },
  { to: '/judges', label: 'For judges', icon: Receipt, kind: 'route' as const, end: false },
]

const SECONDARY_NAV = [
  { to: '/verify-age', label: 'Verify age', icon: ShieldCheck, end: true },
]

function useActiveNav() {
  const { pathname } = useLocation()
  return {
    payView: pathname === '/dashboard/pay' || pathname.startsWith('/dashboard/pay/'),
    overviewView: pathname === '/dashboard',
  }
}

const itemClass = (active: boolean) =>
  `flex shrink-0 items-center gap-3 rounded-full px-4 py-3 text-[15px] font-medium whitespace-nowrap transition-colors ${
    active ? 'bg-white/20 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]' : 'text-white/85 hover:bg-white/10 hover:text-white'
  }`

/** Compact live status for the sidebar bottom: paid/total from the same
    live snapshot the dashboard reads (no extra fetch), plus the last
    successful poll time. Deliberately worded to never collide with the
    dashboard's own "Live"/"Paused" badge text. While loading it says so;
    on error with no data it says the numbers are unavailable — never a
    zero, never a stale count presented as fresh. */
function SidebarStatus() {
  const stats = useStats()
  const invoices = useInvoices()
  const items = invoices.data ?? []
  const paid = stats.data?.paid_total ?? items.filter((i) => i.status === 'paid').length
  const total = stats.data?.payables_total ?? items.length
  const hasData = Boolean(stats.data && invoices.data)
  const failed = (stats.isError || invoices.isError) && !hasData
  const updatedAt = Math.max(stats.dataUpdatedAt ?? 0, invoices.dataUpdatedAt ?? 0)
  const updated = updatedAt > 0 ? formatUtcTime(new Date(updatedAt).toISOString()) : null
  return (
    <div className="mx-4 mb-4 rounded-[12px] border border-white/25 bg-white/10 px-4 py-3 text-white">
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-red-300' : hasData ? 'animate-live-dot bg-emerald-300' : 'bg-white/60'}`}
          aria-hidden="true"
        />
        Registry status
      </p>
      {failed ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/80">Registry numbers unavailable right now.</p>
      ) : !hasData ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/80">Connecting to the test registry…</p>
      ) : (
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/80">
          {paid} of {total} paid once{updated ? ` · updated ${updated} UTC` : ''}
        </p>
      )}
    </div>
  )
}

function SidebarArt() {
  return (
    <div aria-hidden="true">
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
        Every number on this page is live or recorded from the test registry.
      </p>
    </div>
  )
}

function SidebarBrand() {
  return (
    <div className="flex items-center gap-3 px-5 pt-5 pb-6 lg:px-6 lg:pt-8">
      <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home">
        <Logo dark size={32} />
      </Link>
      <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em]">
        {COPY.testnetBadge}
      </span>
    </div>
  )
}

function DesktopSidebar() {
  const { payView, overviewView } = useActiveNav()
  return (
    <aside
      data-testid="app-chrome-desktop"
      className="shrink-0 bg-gradient-to-b from-sky-0 via-sky-1 to-sky-2 text-white lg:flex lg:min-h-screen lg:w-[260px] lg:flex-col"
    >
      <SidebarBrand />
      <nav aria-label="Dashboard" className="flex gap-2 overflow-x-auto px-4 pb-4 lg:flex-col lg:gap-1.5 lg:overflow-visible lg:px-4 lg:pb-0">
        {NAV.map((n) => {
          if (n.kind === 'pay') {
            return (
              <Link key={n.to} to={n.to} aria-current={payView ? 'page' : undefined} className={itemClass(payView)}>
                <n.icon className="h-5 w-5" aria-hidden="true" />
                {n.label}
              </Link>
            )
          }
          if (n.to === '/dashboard') {
            return (
              <Link key={n.to} to={n.to} aria-current={overviewView ? 'page' : undefined} className={itemClass(overviewView)}>
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
        {/* Secondary tools, behind a hairline separator. */}
        <div className="my-2 hidden border-t border-white/20 lg:block" aria-hidden="true" />
        {SECONDARY_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => itemClass(isActive)}>
            <n.icon className="h-5 w-5" aria-hidden="true" />
            {n.label}
          </NavLink>
        ))}
      </nav>
      {/* Sidebar art — the bottom of the sidebar was a long empty brown
          gradient (user's mobile/desktop screenshot). A hairline sunset
          scene in cream strokes, drawn for this sidebar: the sun over the
          hills, and a receipt slip rising from the middle hill. Decorative
          only (aria-hidden), pinned to the bottom with mt-auto, desktop
          only — on phones the sidebar is a horizontal strip and the art
          stays out of it. */}
      <div className="mt-auto hidden lg:block">
        <SidebarStatus />
        <SidebarArt />
      </div>
    </aside>
  )
}

function IconRail() {
  const { payView, overviewView } = useActiveNav()
  const stats = useStats()
  const invoices = useInvoices()
  const hasData = Boolean(stats.data && invoices.data)
  const failed = (stats.isError || invoices.isError) && !hasData
  const railItem = (active: boolean) =>
    `flex min-h-[48px] w-[48px] items-center justify-center rounded-full transition-colors ${
      active ? 'bg-white/20 text-white' : 'text-white/85 hover:bg-white/10 hover:text-white'
    }`
  return (
    <aside
      data-testid="app-chrome-tablet"
      className="flex w-[76px] shrink-0 flex-col items-center bg-gradient-to-b from-sky-0 via-sky-1 to-sky-2 py-5 text-white"
    >
      <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home">
        <Logo dark size={32} />
      </Link>
      <nav aria-label="Dashboard" className="mt-8 flex flex-col items-center gap-1.5">
        {NAV.map((n) => {
          const active = n.kind === 'pay' ? payView : n.to === '/dashboard' ? overviewView : undefined
          if (active !== undefined) {
            return (
              <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} title={n.label} className={railItem(active)}>
                <n.icon className="h-5 w-5" aria-hidden="true" />
              </Link>
            )
          }
          return (
            <NavLink key={n.to} to={n.to} end={n.end} title={n.label} className={({ isActive }) => railItem(isActive)}>
              <n.icon className="h-5 w-5" aria-hidden="true" />
            </NavLink>
          )
        })}
        <div className="my-2 w-10 border-t border-white/20" aria-hidden="true" />
        {SECONDARY_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} title={n.label} className={({ isActive }) => railItem(isActive)}>
            <n.icon className="h-5 w-5" aria-hidden="true" />
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto" title={failed ? 'Registry numbers unavailable' : hasData ? 'Registry reachable' : 'Connecting to the test registry…'}>
        <span
          aria-label={failed ? 'Registry status: unavailable' : hasData ? 'Registry status: reachable' : 'Registry status: connecting'}
          className={`block h-2.5 w-2.5 rounded-full ${failed ? 'bg-red-300' : hasData ? 'animate-live-dot bg-emerald-300' : 'bg-white/60'}`}
        />
      </div>
    </aside>
  )
}

function MobileChrome() {
  const { payView, overviewView } = useActiveNav()
  const stats = useStats()
  const invoices = useInvoices()
  const hasData = Boolean(stats.data && invoices.data)
  const failed = (stats.isError || invoices.isError) && !hasData
  const tabs = [
    { to: '/', label: 'Home', icon: Home, active: undefined as boolean | undefined },
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, active: overviewView },
    { to: '/dashboard/pay?tab=pick', label: 'Pay', icon: Wallet, active: payView },
    { to: '/judges', label: 'Judges', icon: Receipt, active: undefined as boolean | undefined },
    { to: '/verify-age', label: 'Verify age', icon: ShieldCheck, active: undefined as boolean | undefined },
  ]
  // Fragment, not a wrapper div: a sticky header sticks only within its
  // containing block, and a wrapper holding only this header (the tab bar
  // below is fixed, so it contributes no height) is exactly header-height
  // — the header could never stick. As a fragment the header's containing
  // block is the full-height shell root in DashboardShell, so it stays
  // pinned while the page scrolls. The testid lives on the header itself.
  return (
    <>
      <header data-testid="app-chrome-mobile" className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-gradient-to-b from-sky-0 to-sky-1 px-4 py-3 text-white">
        <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home" className="flex items-center gap-3">
          <Logo dark size={28} />
        </Link>
        <span className="flex items-center gap-2">
          <span
            aria-label={failed ? 'Registry status: unavailable' : hasData ? 'Registry status: reachable' : 'Registry status: connecting'}
            title={failed ? 'Registry numbers unavailable' : hasData ? 'Registry reachable' : 'Connecting to the test registry…'}
            className={`h-2.5 w-2.5 rounded-full ${failed ? 'bg-red-300' : hasData ? 'animate-live-dot bg-emerald-300' : 'bg-white/60'}`}
          />
          <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em]">
            {COPY.testnetBadge}
          </span>
        </span>
      </header>
      <nav aria-label="Sections" className="po-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card">
        <ul className="flex">
          {tabs.map((t) => {
            const inner =
              t.active !== undefined ? (
                <Link
                  to={t.to}
                  aria-current={t.active ? 'page' : undefined}
                  className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-[12px] font-medium ${
                    t.active ? 'text-brand-700' : 'text-muted hover:text-ink'
                  }`}
                >
                  <t.icon className="h-5 w-5" aria-hidden="true" />
                  {t.label}
                </Link>
              ) : (
                <NavLink
                  to={t.to}
                  end={t.to === '/'}
                  className={({ isActive }) =>
                    `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-[12px] font-medium ${
                      isActive ? 'text-brand-700' : 'text-muted hover:text-ink'
                    }`
                  }
                >
                  <t.icon className="h-5 w-5" aria-hidden="true" />
                  {t.label}
                </NavLink>
              )
            return <li key={t.to} className="flex flex-1">{inner}</li>
          })}
        </ul>
      </nav>
    </>
  )
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const bp = useBreakpoint()
  return (
    <div className="page-enter min-h-screen bg-paper md:flex">
      {bp === 'desktop' ? <DesktopSidebar /> : bp === 'tablet' ? <IconRail /> : <MobileChrome />}
      <main id="main" className="min-w-0 flex-1 px-4 pt-8 pb-28 sm:px-8 sm:pt-10 md:pb-10">
        {children}
      </main>
    </div>
  )
}
