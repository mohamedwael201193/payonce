// AppHeader — P3 §4 region A + design §3 nav.
// Wordmark "PayOnce" (own generated mark), TESTNET badge, status pill,
// nav (Home, For judges), "Connect wallet" (ghost) and "Verify an invoice"
// (primary). Nav is NOT sticky (P2 §1: header scrolls away with the page).
// "Connect wallet" is a landing affordance (design §5): in the app it opens
// the verify flow — it never asks a judge to sign anything.
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
      <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] ${isActive ? 'bg-white font-medium text-ink' : dark ? 'text-white/90 hover:bg-white/10' : 'text-ink hover:bg-paper-2'}`
          }
        >
          Home
        </NavLink>
        <NavLink
          to="/judges"
          className={({ isActive }) =>
            `rounded-full px-3.5 py-1.5 text-[15px] ${isActive ? 'bg-white font-medium text-ink' : dark ? 'text-white/90 hover:bg-white/10' : 'text-ink hover:bg-paper-2'}`
          }
        >
          For judges
        </NavLink>
        <a
          href="#invoice"
          title="No wallet needed — judges verify without signing anything."
          className="hidden rounded-full border border-white/40 bg-white/15 px-3.5 py-1.5 text-[14px] font-medium text-white hover:bg-white/25 sm:inline-flex"
        >
          Connect wallet
        </a>
        <a
          href="#invoice"
          className="hidden rounded-full bg-white px-3.5 py-1.5 text-[14px] font-medium text-ink sm:inline-flex"
        >
          Verify an invoice
        </a>
        <span className="ml-2 hidden lg:block">
          <StatusPill />
        </span>
      </nav>
    </header>
  )
}
