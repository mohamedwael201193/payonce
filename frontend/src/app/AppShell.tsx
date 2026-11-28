// One slim shell for every /app route: a wordmark, two tabs (Run it, Proof) and the network.
// No sidebar and no dashboard chrome: the app has one job, so the chrome stays out of its way.
// Route changes swap only the <Outlet/>; the page chunks load lazily under one Suspense.
import { Suspense } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import { LogoMark } from '../components/Logo'
import { useHealth } from '../hooks/useApi'
import { Skeleton } from './ui'
import './app.css'
import './shell.css'

/** Shown for the moment a page's own chunk is loading (first visit only). */
function PageFallback() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the page" data-testid="page-fallback">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

const TABS = [
  { to: '/app', label: 'Run it', match: (p: string) => p === '/app' || p === '/app/' || p.startsWith('/app/receipt') },
  { to: '/app/proof', label: 'Proof', match: (p: string) => p.startsWith('/app/proof') },
]

function Network() {
  const health = useHealth()
  const down = health.isError
  return (
    <span className={`sh-net${down ? ' is-down' : ''}`} title={down ? 'The PayOnce API is not answering right now' : 'Concordium testnet'}>
      {down ? 'API offline' : 'Testnet'}
    </span>
  )
}

export function AppShell() {
  const { pathname } = useLocation()
  return (
    <MotionConfig reducedMotion="user">
      <div className="po-app" data-testid="app-shell">
        <a href="#main" className="sh-skip">Skip to content</a>
        <header className="sh-bar">
          <Link to="/" className="sh-brand" aria-label="PayOnce home">
            <LogoMark size={26} />
            <span>PayOnce</span>
          </Link>
          <nav className="sh-tabs" aria-label="App">
            {TABS.map((t) => (
              <Link key={t.to} to={t.to} className="sh-tab" aria-current={t.match(pathname) ? 'page' : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
          <Network />
        </header>
        <main id="main" className="sh-main">
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </MotionConfig>
  )
}
