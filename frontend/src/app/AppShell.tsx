// One shell for every /app route. Route changes swap only the <Outlet/>:
// the chrome, its sliding pill and the data caches stay mounted, and no
// navigation reloads the document. One chrome per breakpoint: a sidebar at
// 1024px and up, a top bar plus a bottom tab bar below it. Only the active
// breakpoint's chrome is in the DOM, so every nav landmark appears once.
import { Suspense, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { MotionConfig, motion } from 'framer-motion'
import {
  ChevronsLeft,
  ChevronsRight,
  FileText,
  LayoutGrid,
  MoreHorizontal,
  Scale,
  ShieldAlert,
  UserCheck,
  Wallet,
  ArrowUpRight,
  Bot,
} from 'lucide-react'
import { LogoMark } from '../components/Logo'
import { useHealth } from '../hooks/useApi'
import { useAppData, useFlag, useIsDesktop } from './hooks'
import { SourceTag, Sheet, Skeleton } from './ui'
import './app.css'

/** Shown for the moment a page's own chunk is loading (first visit only). */
function PageFallback() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the page" data-testid="page-fallback">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutGrid
  /** Path prefix that makes this item active. */
  match: string
  exact?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Overview', icon: LayoutGrid, match: '/app', exact: true },
  { to: '/app/pay', label: 'Pay', icon: Wallet, match: '/app/pay' },
  { to: '/app/invoices', label: 'Invoices', icon: FileText, match: '/app/invoices' },
  { to: '/app/agent', label: 'Agent pays', icon: Bot, match: '/app/agent' },
  { to: '/app/break', label: 'Break it', icon: ShieldAlert, match: '/app/break' },
  { to: '/app/judges', label: 'Judges', icon: Scale, match: '/app/judges' },
]

const MORE_ITEMS: NavItem[] = [{ to: '/app/age', label: 'Age proof', icon: UserCheck, match: '/app/age' }]

function isActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.match
  return pathname === item.match || pathname.startsWith(`${item.match}/`)
}

// Receipts belong to the Invoices task.
function activeFor(item: NavItem, pathname: string): boolean {
  if (item.match === '/app/invoices' && pathname.startsWith('/app/receipt')) return true
  return isActive(item, pathname)
}

const PILL_SPRING = { type: 'spring' as const, stiffness: 520, damping: 42 }

function StatusCard({ collapsed }: { collapsed: boolean }) {
  const health = useHealth()
  const data = useAppData()
  const reachable = health.data?.chain.reachable
  const text = health.isLoading
    ? 'Checking the testnet'
    : health.isError || reachable === false
      ? 'Testnet not answering'
      : health.data?.node_busy
        ? 'Testnet node busy'
        : 'Testnet reachable'
  if (collapsed) {
    return (
      <div className="flex justify-center" title={text}>
        <SourceTag source={data.source} asOf={data.asOf} />
      </div>
    )
  }
  return (
    <div className="rounded-[16px] border border-po-line bg-po-surface p-4 text-sm shadow-[var(--po-shadow-1)]">
      <p className="font-medium text-po-ink">Testnet only</p>
      <p className="mt-1 text-po-grey">{text}. Nothing here is real money.</p>
      <p className="mt-3 flex items-center gap-2 text-po-grey">
        Data <SourceTag source={data.source} asOf={data.asOf} />
      </p>
    </div>
  )
}

function Sidebar() {
  const { pathname } = useLocation()
  const [collapsedFlag, setCollapsedFlag] = useFlag('sidebar')
  const collapsed = collapsedFlag === 'collapsed'
  const itemCls = (active: boolean) =>
    `relative flex min-h-[44px] items-center gap-3 rounded-[10px] px-3 text-[15px] font-medium ${
      active ? 'text-po-ink' : 'text-po-nav-fg hover:bg-po-nav-hover hover:text-po-white'
    } ${collapsed ? 'justify-center' : ''}`
  const renderItem = (item: NavItem) => {
    const active = activeFor(item, pathname)
    return (
      <li key={item.to}>
        <Link
          to={item.to}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed ? item.label : undefined}
          title={collapsed ? item.label : undefined}
          className={itemCls(active)}
        >
          {active ? (
            <motion.span
              layoutId="po-pill-side"
              transition={PILL_SPRING}
              className="absolute inset-0 rounded-[10px] bg-po-accent"
              data-testid="nav-pill"
            />
          ) : null}
          <item.icon className="relative h-5 w-5 shrink-0" aria-hidden="true" />
          {collapsed ? null : <span className="relative">{item.label}</span>}
        </Link>
      </li>
    )
  }
  return (
    <aside
      className="sticky top-0 flex h-screen shrink-0 flex-col border-r border-po-nav-line px-3 py-5"
      style={{ width: collapsed ? 76 : 256, background: 'var(--po-rail)' }}
      data-testid="app-sidebar"
    >
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between px-2'}`}>
        <Link to="/" aria-label="PayOnce, back to the site" className="flex items-center gap-2.5">
          <LogoMark size={32} />
          {collapsed ? null : <span className="text-[17px] font-semibold tracking-[-0.01em] text-po-white">PayOnce</span>}
        </Link>
        {collapsed ? null : (
          <button
            type="button"
            onClick={() => setCollapsedFlag('collapsed')}
            aria-label="Collapse the sidebar"
            className="flex h-11 w-11 items-center justify-center rounded-[10px] text-po-nav-fg hover:bg-po-nav-hover hover:text-po-white"
          >
            <ChevronsLeft className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsedFlag(null)}
          aria-label="Expand the sidebar"
          className="mx-auto mt-2 flex h-11 w-11 items-center justify-center rounded-[10px] text-po-nav-fg hover:bg-po-nav-hover hover:text-po-white"
        >
          <ChevronsRight className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : null}
      <nav aria-label="App" className="mt-6">
        <ul className="flex flex-col gap-1">{NAV_ITEMS.map(renderItem)}</ul>
        <div className="my-4 border-t border-po-nav-line" />
        <ul className="flex flex-col gap-1">
          {MORE_ITEMS.map(renderItem)}
          <li>
            <Link to="/" className={itemCls(false)} aria-label={collapsed ? 'PayOnce site' : undefined} title={collapsed ? 'PayOnce site' : undefined}>
              <ArrowUpRight className="h-5 w-5 shrink-0" aria-hidden="true" />
              {collapsed ? null : <span>PayOnce site</span>}
            </Link>
          </li>
        </ul>
      </nav>
      <div className="mt-auto">
        <StatusCard collapsed={collapsed} />
      </div>
    </aside>
  )
}

function MobileChrome() {
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)
  const data = useAppData()
  // On a phone the tab bar keeps four tasks; Agent pays and Judges live in the More sheet.
  const MOBILE_MORE = [NAV_ITEMS.find((i) => i.to === '/app/judges')!, NAV_ITEMS.find((i) => i.to === '/app/agent')!, ...MORE_ITEMS]
  const moreActive = MOBILE_MORE.some((i) => activeFor(i, pathname))
  return (
    <>
      <header className="sticky top-0 z-30 flex min-h-[56px] items-center justify-between border-b border-po-line bg-po-surface px-4">
        <Link to="/" aria-label="PayOnce, back to the site" className="flex items-center gap-2.5">
          <LogoMark size={28} />
          <span className="text-[17px] font-medium tracking-[-0.01em] text-po-ink">PayOnce</span>
        </Link>
        <div className="flex items-center gap-2">
          <span className="po-tag po-tag-illustration">TESTNET</span>
          <SourceTag source={data.source} asOf={data.asOf} />
        </div>
      </header>
      <nav
        aria-label="App"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-po-line bg-po-surface"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="mx-auto grid max-w-[560px] grid-cols-5">
          {NAV_ITEMS.filter((i) => i.to !== '/app/judges' && i.to !== '/app/agent').map((item) => {
            const active = activeFor(item, pathname)
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                    active ? 'text-po-ink' : 'text-po-grey'
                  }`}
                >
                  {active ? (
                    <motion.span
                      layoutId="po-pill-bottom"
                      transition={PILL_SPRING}
                      className="absolute inset-x-2 inset-y-1.5 rounded-[10px] bg-po-accent"
                      data-testid="nav-pill"
                    />
                  ) : null}
                  <item.icon className="relative h-5 w-5" aria-hidden="true" />
                  <span className="relative">{item.label}</span>
                </Link>
              </li>
            )
          })}
          <li>
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-haspopup="dialog"
              aria-expanded={more}
              className={`flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                moreActive || pathname.startsWith('/app/judges') ? 'font-bold text-po-ink' : 'text-po-ink'
              }`}
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
              More
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="More" initialFocusId="more-first">
        <h2 className="text-xl font-medium text-po-ink">More</h2>
        <ul className="mt-4 flex flex-col gap-1">
          {MOBILE_MORE.map((item, i) => (
            <li key={item.to}>
              <Link
                id={i === 0 ? 'more-first' : undefined}
                to={item.to}
                onClick={() => setMore(false)}
                aria-current={activeFor(item, pathname) ? 'page' : undefined}
                className="flex min-h-[48px] items-center gap-3 rounded-[10px] px-3 text-[16px] font-medium text-po-ink hover:bg-po-sunken"
              >
                <item.icon className="h-5 w-5" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              to="/"
              onClick={() => setMore(false)}
              className="flex min-h-[48px] items-center gap-3 rounded-[10px] px-3 text-[16px] font-medium text-po-ink hover:bg-po-sunken"
            >
              <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
              PayOnce site
            </Link>
          </li>
        </ul>
      </Sheet>
    </>
  )
}

export function AppShell() {
  const desktop = useIsDesktop()
  return (
    <MotionConfig reducedMotion="user">
      <div className="po-app" data-testid="app-shell">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-[10px] focus:bg-po-ink focus:px-4 focus:py-3 focus:text-po-paper"
        >
          Skip to content
        </a>
        <div className={desktop ? 'flex' : ''}>
          {desktop ? <Sidebar /> : <MobileChrome />}
          <main
            id="main"
            className="mx-auto w-full min-w-0 max-w-[1120px] flex-1 px-4 py-6 pb-28 sm:px-8 lg:px-12 lg:py-10 lg:pb-14"
          >
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </MotionConfig>
  )
}
