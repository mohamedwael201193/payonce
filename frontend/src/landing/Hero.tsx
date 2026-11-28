import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clouds } from './Clouds'
import { EASE, Magnetic, Rise } from './bits'
import type { LandingData } from './data'
import { goTo } from './scroll'
import { HeroIdentity } from './HeroIdentity'
import { AgentInboxPanel } from './AgentInbox'

export const HERO_H1 = 'Your AI agent checks\nwho it’s paying.'
export const HERO_LEAD = 'Match or No match, before any money moves. On a match it pays exactly once, to the account the seller registered on Concordium. On no match, nothing is sent.'

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="po-btn__arrow">
      <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The hero: the one idea, two actions, and the agent's last run as an inbox. */
export function Hero(_props: { data: LandingData }) {
  const { scrollY } = useScroll()
  const sink = useTransform(scrollY, [0, 700], [0, 56])
  const reduced = useReducedMotion()
  // The page shell already painted this hero as plain HTML (index.html). Mount
  // in the final state so nothing jumps, then fade the shell away.
  const [booted] = useState(() => typeof document !== 'undefined' && !!document.getElementById('po-boot'))
  const still = reduced || booted
  useEffect(() => {
    const boot = document.getElementById('po-boot')
    if (!boot) return
    let t = 0
    const r = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        boot.style.opacity = '0'
        boot.style.pointerEvents = 'none'
        t = window.setTimeout(() => boot.remove(), 400)
      }),
    )
    return () => {
      cancelAnimationFrame(r)
      window.clearTimeout(t)
    }
  }, [])
  return (
    <section className="po-hero" id="top" aria-labelledby="po-h1">
      <div className="po-hero__sky">
        <Clouds mode="back" bank={470} className="po-hero__cv" />
      </div>
      <div className="po-hero__copy">
        <Rise as="h1" text={HERO_H1} className="po-h1" onLoad instant={booted} delay={0.15} />
        <motion.p
          className="po-lead"
          initial={still ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.55 }}
        >
          {HERO_LEAD}
        </motion.p>
        <motion.div
          className="po-cta-row"
          initial={still ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.7 }}
        >
          <Magnetic>
            <Link to="/app" className="po-btn po-btn--light">
              Run it on a real invoice
              <Arrow />
            </Link>
          </Magnetic>
          <Link to="/app/proof/agent" className="po-btn po-btn--ghost">
            Watch the agent check
          </Link>
          <a
            href="#how"
            className="po-hero__how"
            onClick={(e) => {
              if (goTo('#how')) e.preventDefault()
            }}
          >
            See how it works
          </a>
        </motion.div>
      </div>
      <motion.div className="po-hero__panel po-hero__panel--inbox" style={{ y: still ? 0 : sink }}>
        <motion.div
          initial={still ? false : { opacity: 0, y: 48 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.1, ease: EASE, delay: 0.55 }}
        >
          <AgentInboxPanel />
          <HeroIdentity />
        </motion.div>
      </motion.div>
      <div className="po-hero__front" aria-hidden>
        <Clouds mode="front" bank={280} className="po-hero__cv" />
      </div>
    </section>
  )
}
