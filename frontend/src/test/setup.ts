import '@testing-library/jest-dom'

// jsdom has no IntersectionObserver, but framer-motion's whileInView and our
// CountUp both need one. Stub it to report "intersecting" at once so
// scroll-reveal sections render and count-ups run in tests. (In a real
// browser the native observer is used; this file is test-only.)
if (typeof IntersectionObserver === 'undefined') {
  class IntersectionObserverStub {
    private callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      this.callback(
        [
          {
            isIntersecting: true,
            target,
            boundingClientRect: {} as DOMRectReadOnly,
            intersectionRatio: 1,
            intersectionRect: {} as DOMRectReadOnly,
            rootBounds: null,
            time: 0,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      )
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub
}
