import { Suspense, lazy, useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { OverviewPage } from './app/pages/OverviewPage'
import { PayPage } from './app/pages/PayPage'
import { InvoicesPage } from './app/pages/InvoicesPage'
import { ReceiptPage } from './app/pages/ReceiptPage'
import { BreakPage } from './app/pages/BreakPage'
import { JudgesPage } from './app/pages/JudgesPage'
import { AgeProofPage } from './pages/AgeProofPage'

// The landing lives in src/landing and is the only route outside the app
// shell. It is loaded on demand, so /app visitors never download it.
const LandingPage = lazy(() =>
  import('./landing/LandingPage').then((m) => ({ default: (m as { LandingPage?: React.ComponentType }).LandingPage ?? (m as { default: React.ComponentType }).default })),
)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
})

// Scroll rules. A route change resets the scroll to the top, unless the URL
// carries a hash whose target exists (landing anchors such as #how). Moving
// inside one app page (a different invoice on /app/pay, a filter change on
// /app/invoices) does not scroll: only a change of page family does.
export function routeFamily(pathname: string): string {
  const m = /^\/app\/[^/]+/.exec(pathname)
  return m ? m[0] : pathname
}

function ScrollToTop() {
  const { pathname, hash } = useLocation()
  const prev = useRef<{ family: string; hash: string } | null>(null)
  useEffect(() => {
    const family = routeFamily(pathname)
    const before = prev.current
    prev.current = { family, hash }
    if (before && before.family === family && before.hash === hash) return
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
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      }
    }
    scroll()
  }, [pathname, hash])
  return null
}

// ---- legacy redirects (each one is a single replace, mapped once) ----

/** The seller part of a legacy link: ?seller=<address>, else "1" (the API
    default), which the app resolves against /api/config. */
function legacySeller(params: URLSearchParams): string {
  // No seller named: the number alone can name two invoices, so the app resolves it against the registry list.
  return params.get('seller') || 'any'
}

function legacyPayable(params: URLSearchParams): number | null {
  const n = Number.parseInt(params.get('payable') ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Old pay-flow tab + payable -> the new route. */
export function legacyPayTarget(params: URLSearchParams, hash = ''): string {
  const id = legacyPayable(params)
  const seller = encodeURIComponent(legacySeller(params))
  const tab = params.get('tab')
  if (tab === 'try') return '/app/break'
  if (id && tab === 'receipt') return `/app/receipt/${seller}/${id}`
  if (id) return `/app/pay/${seller}/${id}`
  if (params.has('tab') || hash === '#pay') return '/app/pay'
  return '/app'
}

function LegacyDashboard() {
  const [params] = useSearchParams()
  const { hash } = useLocation()
  return <Navigate to={legacyPayTarget(params, hash)} replace />
}

function LegacyDashboardPay() {
  const [params] = useSearchParams()
  const target = legacyPayTarget(params)
  return <Navigate to={target === '/app' ? '/app/pay' : target} replace />
}

function LegacyReceipt() {
  const { payableId } = useParams()
  const [params] = useSearchParams()
  const id = Number.parseInt(payableId ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) return <Navigate to="/app/invoices" replace />
  return <Navigate to={`/app/receipt/${encodeURIComponent(legacySeller(params))}/${id}`} replace />
}

function LegacyAge() {
  const { search } = useLocation()
  return <Navigate to={`/app/age${search}`} replace />
}

// "/?payable=N" links (shared before v9) go straight to the pay screen.
function LandingRoute() {
  const [params] = useSearchParams()
  const id = legacyPayable(params)
  if (id) return <Navigate to={`/app/pay/${encodeURIComponent(legacySeller(params))}/${id}`} replace />
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#faf6ef' }} aria-busy="true" />}>
      <LandingPage />
    </Suspense>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="pay/*" element={<PayPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="receipt/*" element={<ReceiptPage />} />
        <Route path="break" element={<BreakPage />} />
        <Route path="age" element={<AgeProofPage />} />
        <Route path="judges" element={<JudgesPage />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
      <Route path="/dashboard" element={<LegacyDashboard />} />
      <Route path="/dashboard/pay" element={<LegacyDashboardPay />} />
      <Route path="/judges" element={<Navigate to="/app/judges" replace />} />
      <Route path="/receipt" element={<Navigate to="/app/invoices" replace />} />
      <Route path="/receipt/:payableId" element={<LegacyReceipt />} />
      <Route path="/verify-age" element={<LegacyAge />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ScrollToTop />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
