import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'framer-motion'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EASE_INOUT } from './bits'
import { goTo } from './scroll'

export const NAV_LINKS: readonly [string, string][] = [
  ['How it works', '#how'],
  ['Try to fool it', '#tamper'],
  ['Proof', '#proof'],
  ['FAQ', '#faq'],
]

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="po-mark">
      <rect width="32" height="32" rx="9" className="po-mark__bg" />
      <path d="M9 16.5 14 21.5 23.5 10.5" className="po-mark__tick" />
    </svg>
  )
}

export function Nav() {
  const { scrollY } = useScroll()
  const [pill, setPill] = useState(false)
  const [open, setOpen] = useState(false)
  useMotionValueEvent(scrollY, 'change', (y) => setPill(y > 40))

  const onAnchor = (href: string) => (e: React.MouseEvent) => {
    if (goTo(href)) e.preventDefault()
    setOpen(false)
  }

  return (
    <>
      <motion.header
        className={`po-nav${pill ? ' is-pill' : ''}`}
        layout
        transition={{ type: 'spring', stiffness: 300, damping: 34 }}
      >
        <a href="#top" className="po-nav__brand" onClick={onAnchor('#top')} aria-label="PayOnce, top of page">
          <Mark />
          <span>PayOnce</span>
        </a>
        <nav className="po-nav__links" aria-label="Sections">
          {NAV_LINKS.map(([label, href]) => (
            <a key={href} href={href} onClick={onAnchor(href)}>
              {label}
            </a>
          ))}
        </nav>
        <div className="po-nav__end">
          <Link to="/app/proof/judges" className="po-nav__judges">
            For judges
          </Link>
          <Link to="/app" className="po-btn po-btn--solid po-btn--sm">
            Open the app
          </Link>
          <button
            type="button"
            className="po-nav__menu"
            aria-expanded={open}
            aria-controls="po-sheet"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen(!open)}
          >
            <i />
            <i />
          </button>
        </div>
      </motion.header>
      <AnimatePresence>
        {open && (
          <motion.div
            id="po-sheet"
            className="po-sheet"
            initial={{ clipPath: 'circle(0% at 92% 4%)' }}
            animate={{ clipPath: 'circle(150% at 92% 4%)' }}
            exit={{ clipPath: 'circle(0% at 92% 4%)' }}
            transition={{ duration: 0.55, ease: EASE_INOUT }}
          >
            {NAV_LINKS.map(([label, href], i) => (
              <motion.a
                key={href}
                href={href}
                onClick={onAnchor(href)}
                initial={{ y: 40, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.15 + i * 0.06 }}
              >
                {label}
              </motion.a>
            ))}
            <Link to="/app/proof/judges" onClick={() => setOpen(false)}>
              For judges
            </Link>
            <Link to="/app" onClick={() => setOpen(false)}>
              Open the app
            </Link>
            <Link to="/app" className="po-btn po-btn--solid" onClick={() => setOpen(false)}>
              Pay a live invoice
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
