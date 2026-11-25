// Home page — DISPLAY-ONLY landing (fix-back-12). The interactive pay flow
// used to live here (pick / check / pay / receipt / try + build status +
// sticky pay bar); it moved entirely into /dashboard as manual tabs
// (components/PayFlowTabs.tsx). What stays: the hero + small demo glimpse
// (Hero/HeroDemo, props-only static, zero network calls) + explanation
// (hairline figures + explainer sections). No invoice picker, no check
// step, no pay button, no receipt checker, no try panel, no build-status
// section, no '#invoice' anchor target.
// Accepts ?payable=<id> only to redirect old shared links to the dashboard
// pay tabs (/?payable=N → /dashboard?tab=pick&payable=N#pay).
import { Navigate, useSearchParams } from 'react-router-dom'
import { Hero } from '../components/Hero'
import { HeroDemo } from '../components/HeroDemo'
import { CtaBand, Features, Footer, HairlineFigures, HowItWorks, InvoiceShowcase, JudgesSection, PlannerSection, VerifierSection } from '../components/Sections'
import { formatUtcTime } from '../lib/format'
import { useInvoices, useStats } from '../hooks/useApi'

export function HomePage() {
  const [params] = useSearchParams()
  // Live inputs for the small demo card only (HeroDemo's chips + table).
  // No other live-dashboard surface is rendered on the landing.
  const demoInvoices = useInvoices()
  const demoStats = useStats()
  // Fix-back-8 MF-4: home shows a "Last updated" line for the demo card
  // (it had none — the dashboard's line is the last successful poll, so
  // this one reads the same dataUpdatedAt, not the server's verifier
  // run). demoInvoices and demoStats are the same underlying
  // ['live-snapshot'] query, so either dataUpdatedAt is the poll time.
  const demoUpdatedAt = Math.max(demoInvoices.dataUpdatedAt ?? 0, demoStats.dataUpdatedAt ?? 0)
  const demoLastUpdated = demoUpdatedAt > 0 ? `${formatUtcTime(new Date(demoUpdatedAt).toISOString())} UTC` : null

  // Old shared links (?payable=N) go to the dashboard pay tabs, not here.
  const payable = params.get('payable')
  const payableId = Number.parseInt(payable ?? '', 10)
  if (Number.isFinite(payableId) && payableId > 0) {
    return <Navigate to={`/dashboard?tab=pick&payable=${payableId}#pay`} replace />
  }

  return (
    <div id="top" className="page-enter min-h-screen bg-paper">
      <main id="main">
        <Hero />
        {/* Small demo card — the ONLY dashboard in the hero (user order
            2026-11-25 03:40: the real dashboard lives only in /dashboard;
            the landing shows a demo, small and clearly Demo-labeled). The
            static demo glimpse, reshaped small (~60% width), pulled up
            over the hero's cloud band. */}
        <section aria-label="Demo dashboard" className="relative z-10 mx-auto max-w-[820px] px-4 sm:px-6">
          <div className="relative -mt-[100px] overflow-hidden rounded-[24px] border border-line bg-card shadow-[0_30px_80px_rgba(23,19,16,0.25)]">
            <HeroDemo items={demoInvoices.data ?? []} stats={demoStats.data} error={demoInvoices.isError || demoStats.isError} lastUpdated={demoLastUpdated} />
          </div>
        </section>
        {/* The live console and the live stats band used to sit here; per
            the user order 2026-11-25 03:40 they live ONLY in /dashboard now
            — the landing embeds no real dashboard. Live numbers appear on
            the landing only inside the Demo-labeled hero card (chips +
            table, disclosed in its footer). */}
        <Features />
        <HowItWorks />
        <HairlineFigures />
        <InvoiceShowcase />
        <VerifierSection />
        <PlannerSection />
        <JudgesSection />
        <CtaBand />
      </main>
      <Footer />
    </div>
  )
}
