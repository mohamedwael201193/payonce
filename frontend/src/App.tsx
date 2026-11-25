import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { DashboardPage } from './pages/DashboardPage'
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
// feels like a dead end. Hash links (/#invoice, /#check, …) scroll to their
// anchor instead; the browser does not do that for client-side routing.
//
// TAB BUG (2026-11-25, user-reported, browser test pass 1 bug 1): "Pay an
// invoice" from /dashboard or the footer left the URL at /#invoice but the
// view at the hero — three causes, all fixed here:
//   (1) Same-hash re-clicks were dead: the effect depended on [pathname,
//       hash], and clicking "Pay an invoice" while already on /#invoice
//       changes neither, so nothing scrolled. It now also depends on
//       location.key — React Router mints a new key per navigation,
//       including a same-URL one, so every tab click scrolls.
//   (2) The scroll was smooth: the landing's heights shift while live data
//       loads (the demo card grows from its skeleton), so a smooth scroll
//       animated toward a stale offset and landed short, on the hero. The
//       scroll is instant now — it lands exactly — and the demo card holds
//       a stable height while loading so the offset does not move.
//   (3) A late-mounting anchor was missed outright: if the target is not
//       in the DOM yet, the scroll retries on the next frames (up to 10)
//       instead of giving up silently.
function ScrollToTop() {
  const { pathname, hash, key } = useLocation()
  useEffect(() => {
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
        return
      }
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        ;(el as HTMLElement).scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' })
        return
      }
      if (tries < 10) {
        tries += 1
        requestAnimationFrame(scroll)
      }
    }
    scroll()
  }, [pathname, hash, key])
  return null
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/receipt/:payableId" element={<ReceiptPage />} />
          <Route path="/judges" element={<JudgesPage />} />
          <Route path="/verify-age" element={<AgeProofPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
