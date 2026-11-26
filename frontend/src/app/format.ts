// App formatting helpers.

/** "0.500000 CCD" -> "0.5 CCD", "10.00 EUDemo" -> "10 EUDemo". */
export function tidyAmount(s: string): string {
  const m = /^(-?[\d,]+(?:\.\d+)?)\s+(\S+)$/.exec(s.trim())
  if (!m) return s
  let n = m[1]
  if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '')
  return `${n} ${m[2]}`
}

/** "10:42" in UTC from an ISO string. */
export function clockUtc(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(11, 16)} UTC`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
