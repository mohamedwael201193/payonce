import { useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { DashboardPage } from './pages/DashboardPage'
import { DashboardPayPage } from './pages/DashboardPayPage'
import { ReceiptPage } from './pages/ReceiptPage'
import { JudgesPage } from './pages/JudgesPage'
import { AgeProofPage } from './pages/AgeProofPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
})

// Route changes reset the scroll position — otherwise a jump from the
// bottom of /dashboard lands mid-page on the landing page and the return
// feels like a dead end.
//
// SCROLL RULE (2026-11-26 pay-route fix — replaces the old hash-on-every-
// change behaviour that yanked fresh loads of /dashboard?tab=pick#pay
// down to the #pay section below all dashboard content):
//   - Pathname change -> scroll to top, unless the URL carries a hash
//     whose target exists (genuine landing anchors like #how) — then
//     scroll to that target instead, retrying a few frames for a
//     late-mounting target. A hash with no target in the DOM scrolls
//     to the top, never nowhere.
//   - Hash-only change (same pathname) -> scroll to the hash target
//     when it exists (clicking "See how it works" while already on /).
//   - Query-only change -> NO scroll at all. Tab switches on
//     /dashboard/pay change only ?tab=, so the view stays exactly
//     where the user is.
// A same-URL re-click changes neither pathname nor hash, so the effect
// does not re-run and the view stays — the old same-hash re-click case
// is gone with the #pay anchor (the pay link is a different pathname
// now, /dashboard/pay).
//
// The old /#invoice anchor is gone with the landing flow (fix-back-12).
function ScrollToTop() {
  const { pathname, search, hash } = useLocation()
  const prev = useRef<{ pathname: string; hash: string } | null>(null)
  useEffect(() => {
    const prevLoc = prev.current
    prev.current = { pathname, hash }
    // Query-only change (a tab switch): do not scroll.
    if (prevLoc && prevLoc.pathname === pathname && prevLoc.hash === hash) return
    if (!hash) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      return
    }
    let tries = 0
    const scroll = () => {
      let el: Element | null = null
      try {
        el = document.querySelector(hash)
      } catch {
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
        return
      }
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        ;(el as HTMLElement).scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' })
        return
      }
      if (tries < 10) {
        tries += 1
        requestAnimationFrame(scroll)
      } else {
        // Hash target never mounted: top, not nowhere.
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      }
    }
    scroll()
  }, [pathname, search, hash])
  return null
}

// Legacy deep links: the pay flow used to live on /dashboard as
// ?tab=…#pay. Those URLs redirect to the pay route, keeping every query
// param (?tab=, ?payable=, ?seller=) and dropping the dead #pay hash.
function DashboardRoute() {
  const { search, hash } = useLocation()
  const params = new URLSearchParams(search)
  if (params.has('tab') || params.has('payable') || hash === '#pay') {
    return <Navigate to={`/dashboard/pay${search}`} replace />
  }
  return <DashboardPage />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/dashboard/pay" element={<DashboardPayPage />} />
          <Route path="/receipt/:payableId" element={<ReceiptPage />} />
          <Route path="/judges" element={<JudgesPage />} />
          <Route path="/verify-age" element={<AgeProofPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
