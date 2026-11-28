import { Suspense, lazy, useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { RunPage } from './app/run/RunPage'
import { dashEnabled } from './dash/flag'

// Code splitting: the shell and the Run-it flow (the /app screen) ship in the
// main chunk; every other page is its own chunk, fetched on first visit. The
// agent page carries the bundled run record (~50 kB of JSON), so /app no longer
// downloads it up front.
function page<K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })))
}
const ReceiptPage = page(() => import('./app/pages/ReceiptPage'), 'ReceiptPage')
const BreakPage = page(() => import('./app/pages/BreakPage'), 'BreakPage')
const AgentPage = page(() => import('./app/pages/AgentPage'), 'AgentPage')
const JudgesPage = page(() => import('./app/pages/JudgesPage'), 'JudgesPage')
const X402Page = page(() => import('./app/pages/X402Page'), 'X402Page')
const ProofPage = page(() => import('./app/pages/ProofPage'), 'ProofPage')
const NotFoundPage = page(() => import('./app/pages/ProofPage'), 'NotFoundPage')
const AgeProofPage = page(() => import('./pages/AgeProofPage'), 'AgeProofPage')
const DemoPage = page(() => import('./demo/DemoPage'), 'DemoPage')
const DashPage = page(() => import('./dash/DashPage'), 'DashPage')
const PayeePage = page(() => import('./dash/PayeePage'), 'PayeePage')
const CensusPage = page(() => import('./dash/CensusPage'), 'CensusPage')
const SellPage = page(() => import('./app/pages/SellPage'), 'SellPage')

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
  if (tab === 'try') return '/app/proof/break'
  if (id && tab === 'receipt') return `/app/receipt/${seller}/${id}`
  void hash
  return '/app'
}

function LegacyDashboard() {
  const [params] = useSearchParams()
  const { hash } = useLocation()
  return <Navigate to={legacyPayTarget(params, hash)} replace />
}

function LegacyDashboardPay() {
  const [params] = useSearchParams()
  return <Navigate to={legacyPayTarget(params)} replace />
}

function LegacyReceipt() {
  const { payableId } = useParams()
  const [params] = useSearchParams()
  const id = Number.parseInt(payableId ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) return <Navigate to="/app" replace />
  return <Navigate to={`/app/receipt/${encodeURIComponent(legacySeller(params))}/${id}`} replace />
}

function KeepSearch({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}

function LegacyAge() {
  const { search } = useLocation()
  return <Navigate to={`/app/proof/age${search}`} replace />
}

// "/?payable=N" links (shared before v9) go straight to the pay screen.
function LandingRoute() {
  const [params] = useSearchParams()
  const id = legacyPayable(params)
  if (id) return <Navigate to={`/app/receipt/${encodeURIComponent(legacySeller(params))}/${id}`} replace />
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#f1f3f8' }} aria-busy="true" />}>
      <LandingPage />
    </Suspense>
  )
}

/** /app: the new dashboard behind its flag (?dash=1), the Run-it flow otherwise. */
function AppIndex() {
  const { search } = useLocation()
  return dashEnabled(search) ? <DashPage /> : <RunPage />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/faq" element={<Navigate to={{ pathname: '/', hash: 'faq' }} replace />} />
      <Route path="/demo" element={<Suspense fallback={<div style={{ minHeight: '100vh', background: '#0e1219' }} aria-busy="true" />}><DemoPage /></Suspense>} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<AppIndex />} />
        <Route path="run" element={<RunPage />} />
        <Route path="receipt/*" element={<ReceiptPage />} />
        <Route path="proof" element={<ProofPage />} />
        <Route path="proof/agent" element={<AgentPage />} />
        <Route path="proof/break" element={<BreakPage />} />
        <Route path="proof/judges" element={<JudgesPage />} />
        <Route path="proof/age" element={<AgeProofPage />} />
        <Route path="proof/x402" element={<X402Page />} />
        <Route path="proof/census" element={<CensusPage />} />
        <Route path="sell" element={<SellPage />} />
        <Route path="wallet" element={<Navigate to="/app" replace />} />
        {/* Old addresses keep working. */}
        <Route path="agent" element={<Navigate to="/app/proof/agent" replace />} />
        <Route path="break" element={<Navigate to="/app/proof/break" replace />} />
        <Route path="judges" element={<Navigate to="/app/proof/judges" replace />} />
        <Route path="age" element={<KeepSearch to="/app/proof/age" />} />
        <Route path="pay/*" element={<Navigate to="/app" replace />} />
        <Route path="invoices" element={<Navigate to="/app" replace />} />
        <Route path="x402" element={<Navigate to="/app/proof/x402" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="/p/:account" element={<Suspense fallback={<div style={{ minHeight: '100vh', background: '#f1f3f8' }} aria-busy="true" />}><PayeePage /></Suspense>} />
      <Route path="/dashboard" element={<LegacyDashboard />} />
      <Route path="/dashboard/pay" element={<LegacyDashboardPay />} />
      <Route path="/judges" element={<Navigate to="/app/proof/judges" replace />} />
      <Route path="/receipt" element={<Navigate to="/app" replace />} />
      <Route path="/receipt/:payableId" element={<LegacyReceipt />} />
      <Route path="/verify-age" element={<LegacyAge />} />
      <Route path="*" element={<AppShell />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
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
