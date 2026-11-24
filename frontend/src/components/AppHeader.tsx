// AppHeader — P3 §4 region A + design §3 nav, video-matched (VIDEO_ANALYSIS.md).
// New logo (SVG once-loop mark + PayOnce wordmark, components/Logo.tsx) that
// ALWAYS links back to the landing page. CENTER pill nav in a translucent
// rounded bar (active item = solid white pill, like the video's Product
// pill). Fix round 2: the pill nav was `hidden md:flex` — on phones there
// was NO way to switch tabs except footer links, so the mobile nav is now a
// full-width pill row under the header on <md screens, with the same active
// state (NavLink sets aria-current="page" on the active tab). The header
// sits OVER the sunset sky on the home page (rendered by Hero) and over the
// deep-ember band on the judges/receipt pages. Nav is NOT sticky: the
// header scrolls away.
// "Connect wallet" is a landing affordance: in the app it opens the verify
// flow — it never asks a judge to sign anything. The CTAs point at
// "/#invoice" so they work from every page, not just home.
import { Link, NavLink } from 'react-router-dom'
import { useHealth } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { Logo } from './Logo'

export function StatusPill() {
  const { data, isLoading, isError } = useHealth()
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-medium text-white">
        <span className="h-2 w-2 rounded-full bg-white/60" aria-hidden="true" />
        CONNECTING
      </span>
    )
  }
  if (isError || !data) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-medium text-white">
        <span className="h-2 w-2 rounded-full bg-amber" aria-hidden="true" />
        NO LIVE DATA
      </span>
    )
  }
  if (!data.chain.reachable) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-medium text-white">
        <span className="h-2 w-2 rounded-full bg-amber" aria-hidden="true" />
        LAST VERIFIED · refresh paused
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-medium text-white">
      <span className="h-2 w-2 rounded-full bg-verified-bg" aria-hidden="true" />
      LIVE
    </span>
  )
}

const NAV_ITEMS = [
  { to: '/', label: 'Home', end: true },
  { to: '/dashboard', label: 'Dashboard', end: false },
  { to: '/judges', label: 'For judges', end: false },
] as const

function MainNavLinks() {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-white ${
              isActive ? 'bg-white font-medium text-ink' : 'text-white/90 hover:bg-white/10'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </>
  )
}

export function AppHeader({ dark = true, skipTarget = '#main' }: { dark?: boolean; skipTarget?: string }) {
  return (
    <header className="relative z-20 mx-auto max-w-[1101px] px-4 pt-5 sm:px-6">
      <a
        href={skipTarget}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to the invoice
      </a>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home">
            <Logo dark={dark} size={32} />
          </Link>
          <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-white">
            {COPY.testnetBadge}
          </span>
        </div>
        <nav aria-label="Main" className="hidden items-center gap-1 rounded-full border border-white/25 bg-white/15 p-1 backdrop-blur md:flex">
          <MainNavLinks />
        </nav>
        <div className="flex items-center gap-3">
          <a
            href="/#invoice"
            title="No wallet needed — judges verify without signing anything."
            className="hidden rounded-full border border-white/40 bg-white/15 px-3.5 py-1.5 text-[14px] font-medium text-white hover:bg-white/25 sm:inline-flex"
          >
            Connect wallet
          </a>
          <a href="/#invoice" className="btn-ember !min-h-[40px] !px-4 !py-1.5 !text-[14px]">
            Verify an invoice
          </a>
          <span className="ml-2 hidden lg:block">
            <StatusPill />
          </span>
        </div>
      </div>
      {/* Mobile nav — the same three tabs, same active pill, full width.
          Without this, phones had no tab navigation at all. */}
      <nav
        aria-label="Main"
        className="mt-3 flex items-center gap-1 overflow-x-auto rounded-full border border-white/25 bg-white/15 p-1 backdrop-blur md:hidden"
      >
        <MainNavLinks />
      </nav>
    </header>
  )
}
