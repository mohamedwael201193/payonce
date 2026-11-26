// Smooth scroll glue. LandingPage registers the Lenis instance here; anchors
// then glide through Lenis, or jump natively when Lenis is off (reduced
// motion, ?nolenis) so nothing ever depends on it.
import type Lenis from 'lenis'

let instance: Lenis | null = null

export function setLenis(l: Lenis | null) {
  instance = l
}

/** Scroll to an in-page anchor. Returns true when it handled the click. */
export function goTo(hash: string): boolean {
  const el = hash === '#top' ? document.documentElement : document.querySelector(hash)
  if (!el) return false
  if (instance) {
    if (hash === '#top') instance.scrollTo(0)
    else instance.scrollTo(el as HTMLElement, { offset: -72 })
    return true
  }
  if (hash === '#top') window.scrollTo({ top: 0 })
  else (el as HTMLElement).scrollIntoView({ block: 'start' })
  history.replaceState(null, '', hash === '#top' ? window.location.pathname + window.location.search : hash)
  return true
}
