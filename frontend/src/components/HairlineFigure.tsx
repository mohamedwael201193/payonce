// HairlineFigure — embeds one self-contained hairline figure page
// (frontend/public/figures/hairline-<name>.html, built by the hairline
// skill's build.mjs from frontend/src/hairline/<name>.js) as an iframe.
// The page carries its own pointer, slider, play tour and read-out; the
// iframe is sized to the bench's own proportions (400×320 stage + the
// controls and the line under it). ?play=1 starts the tour on load; the
// tour gives way to a real pointer the moment one arrives.
// Load failure: a figure that 404s used to leave a blank bordered box +
// caption. On load the component checks the same-origin document for the
// figure root (#hl-figure, present in all three built pages) and on error
// it swaps the iframe for a fallback box that says so — never a blank box.
import { useEffect, useRef, useState } from 'react'

export function HairlineFigure({ name, caption }: { name: string; caption: string }) {
  const [failed, setFailed] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // The error listener is attached natively: React's onError prop does
  // not fire for iframes (their error events do not reach React's root
  // listener), so a native listener is the only reliable hook.
  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    const onErr = () => setFailed(true)
    el.addEventListener('error', onErr)
    return () => el.removeEventListener('error', onErr)
  }, [])

  const checkLoaded = () => {
    const doc = iframeRef.current?.contentDocument
    // Same-origin figure pages always carry #hl-figure. A missing root
    // means the load answered with something else (404 page, proxy error
    // page) — show the fallback instead of a blank box. A null document
    // (cross-origin, never here) leaves the iframe as-is.
    if (doc && !doc.querySelector('#hl-figure')) setFailed(true)
  }

  if (failed) {
    return (
      <figure>
        <div
          role="alert"
          className="flex aspect-[400/500] w-full flex-col items-center justify-center gap-2 rounded-[12px] border border-line bg-card p-6 text-center"
        >
          <p className="text-sm font-medium text-ink">Figure did not load.</p>
          <p className="text-sm text-muted">
            The hairline diagram ({name}) could not be loaded. Try refreshing the page.
          </p>
        </div>
        <figcaption className="mt-3 text-center text-sm leading-relaxed text-muted">{caption}</figcaption>
      </figure>
    )
  }

  return (
    <figure>
      <iframe
        ref={iframeRef}
        src={`/figures/hairline-${name}.html?play=1`}
        title={`Hairline figure: ${name}`}
        loading="lazy"
        onLoad={checkLoaded}
        className="aspect-[400/500] w-full overflow-hidden rounded-[12px] border border-line bg-card"
      />
      <figcaption className="mt-3 text-center text-sm leading-relaxed text-muted">{caption}</figcaption>
    </figure>
  )
}
