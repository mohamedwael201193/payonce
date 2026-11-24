// Formatting helpers. P3 §2 rule 13: hashes display as first 8 + last 6
// characters; copy gives the full value. Unknown values show "—" with a
// reason, never a fallback number (rule 9).

export function truncHash(hash: string): string {
  if (!hash) return '—'
  if (hash.length <= 14) return hash
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`
}

export function truncAddress(address: string): string {
  return truncHash(address)
}

/** Format a base-unit amount string (6 decimals) for display. */
export function formatAmount(baseUnits: string, decimals = 6): string {
  const n = BigInt(baseUnits)
  const divisor = 10n ** BigInt(decimals)
  const whole = n / divisor
  const frac = n % divisor
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

export function formatCcd(baseUnits: string): string {
  return `${formatAmount(baseUnits)} CCD`
}

export function formatEudemo(baseUnits: string): string {
  return `${formatAmount(baseUnits)} EUDemo`
}

/** UTC time as HH:MM:SS (for verifier lines, P3 §10). */
export function formatUtcTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(11, 19)
}

export function formatUtcDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 16)} UTC`
}

/** Seconds left on a reservation countdown, rendered mm:ss. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Human "due in" from an ISO due date: "in 2h 14m", "in 3d 2h", "past due". */
export function formatDueIn(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diffMs = d.getTime() - Date.now()
  if (diffMs <= 0) return 'past due'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `in ${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `in ${days}d ${hours % 24}h`
}
