// The new dashboard is behind a flag until the PLANNED endpoints land.
// On: ?dash=1 (remembered), or VITE_DASH=1 at build time. Off: ?dash=0.
export function dashEnabled(search = typeof location === 'undefined' ? '' : location.search): boolean {
  const p = new URLSearchParams(search).get('dash')
  try {
    if (p === '1') localStorage.setItem('po-dash', '1')
    if (p === '0') localStorage.removeItem('po-dash')
    if (p === null && localStorage.getItem('po-dash') === '1') return true
  } catch { /* private mode */ }
  if (p === '1') return true
  if (p === '0') return false
  return import.meta.env.VITE_DASH === '1'
}
