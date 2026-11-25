// HairlineFigure — a figure that fails to load must show a fallback box
// that says so, never a blank bordered box + caption.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HairlineFigure } from './HairlineFigure'

describe('HairlineFigure load failure (FIX-7e)', () => {
  it('shows the fallback when the loaded document has no figure root (404 / error page)', () => {
    render(<HairlineFigure name="payable" caption="Payable figure" />)
    const iframe = screen.getByTitle('Hairline figure: payable')
    expect(screen.queryByRole('alert')).toBeNull()
    // jsdom never loads the iframe: its document is empty, so the load
    // check finds no #hl-figure — exactly the 404/error-page case.
    fireEvent.load(iframe)
    expect(screen.getByRole('alert')).toHaveTextContent('Figure did not load.')
    expect(screen.queryByTitle('Hairline figure: payable')).toBeNull()
    expect(screen.getByText('Payable figure')).toBeInTheDocument()
  })

  it('shows the fallback on an iframe error event', () => {
    render(<HairlineFigure name="seal" caption="Seal figure" />)
    fireEvent.error(screen.getByTitle('Hairline figure: seal'))
    expect(screen.getByRole('alert')).toHaveTextContent('The hairline diagram (seal) could not be loaded.')
  })

  it('keeps the iframe when the loaded document carries the figure root', () => {
    const { container } = render(<HairlineFigure name="receipt" caption="Receipt figure" />)
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    // jsdom never loads the iframe (its contentDocument has no body), so
    // stand in a real document carrying the figure root for the load check.
    const fakeDoc = document.implementation.createHTMLDocument()
    fakeDoc.body.insertAdjacentHTML('beforeend', '<div id="hl-figure"></div>')
    Object.defineProperty(iframe, 'contentDocument', { value: fakeDoc, configurable: true })
    fireEvent.load(iframe)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTitle('Hairline figure: receipt')).toBeInTheDocument()
  })

  // Fix-back-6 B8: the iframe must never scroll internally — it sizes
  // itself to the figure page's content height and carries scrolling="no".
  it('sizes the iframe to the figure content height, with no internal scrolling', () => {
    const { container } = render(<HairlineFigure name="payable" caption="Payable figure" />)
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('scrolling')).toBe('no')
    const fakeDoc = document.implementation.createHTMLDocument()
    fakeDoc.body.insertAdjacentHTML('beforeend', '<div id="hl-figure"></div>')
    Object.defineProperty(fakeDoc.documentElement, 'scrollHeight', { value: 620, configurable: true })
    Object.defineProperty(iframe, 'contentDocument', { value: fakeDoc, configurable: true })
    fireEvent.load(iframe)
    expect(iframe.style.height).toBe('620px')
  })

  // Fix-back-7 S4: the outer ResizeObserver watches the iframe only, so
  // post-load INNER growth (controls reflow) used to clip silently behind
  // scrolling="no" with no scrollbar. The inner documentElement is
  // observed too — when it grows, the iframe re-fits with no outer resize.
  it('re-fits when the inner figure content grows after load', () => {
    const callbacks: ResizeObserverCallback[] = []
    const observed: Element[] = []
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb)
      }
      observe(target: Element) {
        observed.push(target)
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    try {
      const { container } = render(<HairlineFigure name="payable" caption="Payable figure" />)
      const iframe = container.querySelector('iframe') as HTMLIFrameElement
      const fakeDoc = document.implementation.createHTMLDocument()
      fakeDoc.body.insertAdjacentHTML('beforeend', '<div id="hl-figure"></div>')
      const docEl = fakeDoc.documentElement
      let height = 620
      Object.defineProperty(docEl, 'scrollHeight', { get: () => height, configurable: true })
      Object.defineProperty(iframe, 'contentDocument', { value: fakeDoc, configurable: true })
      fireEvent.load(iframe)
      expect(iframe.style.height).toBe('620px')
      // The inner documentElement is observed, not just the outer iframe.
      expect(observed).toContain(docEl)
      // Post-load inner growth re-fits with no outer resize. The observer
      // callbacks run outside React's event system, so they need act().
      height = 700
      act(() => {
        for (const cb of callbacks) cb([], null as unknown as ResizeObserver)
      })
      expect(iframe.style.height).toBe('700px')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
