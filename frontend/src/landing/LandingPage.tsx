import { MotionConfig } from 'framer-motion'
import Lenis from 'lenis'
import { useEffect } from 'react'
import { Closer, Faq, Footer } from './Closer'
import { Hero } from './Hero'
import { Judges } from './Judges'
import { Nav } from './Nav'
import { Proof } from './Proof'
import { Story } from './Story'
import { Tamper } from './Tamper'
import { warmDemoRun } from '../demo/demoData'
import { setLenis } from './scroll'
import { useLandingData, type Snapshot } from './data'
import './landing.css'

/** Smooth scroll, landing only. Off under reduced motion and with ?nolenis. */
function useLenis() {
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || location.search.includes('nolenis')) return
    const lenis = new Lenis({ lerp: 0.1 })
    setLenis(lenis)
    let raf = 0
    const tick = (t: number) => {
      lenis.raf(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      lenis.destroy()
      setLenis(null)
    }
  }, [])
}

export default function LandingPage({ snapshot }: { snapshot?: Snapshot }) {
  const data = useLandingData(snapshot)
  useLenis()
  useEffect(() => { warmDemoRun() }, [])
  return (
    <MotionConfig reducedMotion="user">
      <div className="po" data-testid="landing">
        <Nav />
        <main id="main">
          <Hero data={data} />
          <Story snapshot={data.snapshot} />
          <Tamper snapshot={data.snapshot} />
          <Proof snapshot={data.snapshot} />
          <Judges snapshot={data.snapshot} />
          <Faq snapshot={data.snapshot} />
          <Closer />
        </main>
        <Footer snapshot={data.snapshot} />
      </div>
    </MotionConfig>
  )
}

export { LandingPage }
