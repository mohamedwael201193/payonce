// AppHeader — P3 §4 region A + design §3 nav, video-matched (VIDEO_ANALYSIS.md).
// Wordmark "PayOnce" (own generated mark), TESTNET badge, status pill,
// CENTER pill nav in a translucent rounded bar (active item = solid white
// pill, like the video's Product pill), right: "Connect wallet" (ghost) and
// "Verify an invoice" (solid white). The header sits OVER the sunset sky on
// the home page (rendered by Hero) and over the deep-ember band on the
// judges/receipt pages. Nav is NOT sticky: the header scrolls away.
// "Connect wallet" is a landing affordance: in the app it opens the verify
// flow — it never asks a judge to sign anything. The CTAs point at
// "/#invoice" so they work from every page, not just home.
import { Link, NavLink } from 'react-router-dom'
import { useHealth } from '../hooks/useApi'
import { COPY } from '../lib/copy'

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

export function AppHeader({ dark = true, skipTarget = '#main' }: { dark?: boolean; skipTarget?: string }) {
  return (
    <header className="relative z-20 mx-auto flex max-w-[1101px] flex-wrap items-center justify-between gap-3 px-4 pt-5 sm:px-6">
      <a
        href={skipTarget}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to the invoice
      </a>
      <div className="flex items-center gap-3">
        <Link to="/" className="flex items-center gap-2.5" aria-label="PayOnce home">
          <img src="/assets/payonce-mark.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-[4px]" />
          <span className={`text-[17px] font-medium tracking-[-0.01em] ${dark ? 'text-white' : 'text-ink'}`}>
            PayOnce
          </span>
        </Link>
        <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-white">
          {COPY.testnetBadge}
        </span>
      </div>
      <nav
        aria-label="Main"
        className="hidden items-center gap-1 rounded-full border border-white/25 bg-white/15 p-1 backdrop-blur md:flex"
      >
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] ${isActive ? 'bg-white font-medium text-ink' : 'text-white/90 hover:bg-white/10'}`
          }
        >
          Home
        </NavLink>
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] ${isActive ? 'bg-white font-medium text-ink' : 'text-white/90 hover:bg-white/10'}`
          }
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/judges"
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] ${isActive ? 'bg-white font-medium text-ink' : 'text-white/90 hover:bg-white/10'}`
          }
        >
          For judges
        </NavLink>
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
    </header>
  )
}
