// The key of a payable is (seller, id). Seller 2's payables share ids with
// seller 1's (the registry keys by seller + id), so an id alone names two
// different invoices. Every route, query key and API call in the app goes
// through this file; nothing builds a payable URL from an id by itself.

export interface PayableKey {
  /** Seller account address (full), as the API reports it. */
  seller: string
  id: number
}

export const keyStr = (k: PayableKey): string => `${k.seller}:${k.id}`

export const payPath = (k?: PayableKey | null): string => (k ? `/app/pay/${k.seller}/${k.id}` : '/app/pay')
export const receiptPath = (k: PayableKey): string => `/app/receipt/${k.seller}/${k.id}`

/** Split "<seller>/<id>" (the splat of /app/pay/* and /app/receipt/*). */
export function parseKeyPath(splat: string | undefined): { sellerParam: string; id: number } | null {
  if (!splat) return null
  const parts = splat.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const id = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(id) || id <= 0 || String(id) !== parts[1]) return null
  return { sellerParam: decodeURIComponent(parts[0]), id }
}

export interface SellerInfo {
  seller: string
  label: string
}

/** A route may name the seller by address, or by "1" / "2" (the position in
    /api/config sellers). Legacy links with no seller resolve to "1", which
    is the API default. Returns the address, or null when it cannot be
    resolved (yet). */
export function resolveSeller(param: string, sellers: SellerInfo[]): string | null {
  if (sellers.some((s) => s.seller === param)) return param
  if (/^[1-9]$/.test(param)) return sellers[Number(param) - 1]?.seller ?? null
  return null
}

/** "Seller 1" / "Seller 2" from the config label, else a short address. */
export function sellerName(address: string, sellers: SellerInfo[]): string {
  const found = sellers.find((s) => s.seller === address)
  if (found) return found.label.split(' — ')[0].split(' - ')[0]
  return `Seller ${address.slice(0, 6)}`
}

export interface KeyedItem {
  payable_id: number
  seller: string
}

export const sameKey = (a: PayableKey, b: PayableKey): boolean => a.seller === b.seller && a.id === b.id
export const itemKey = (i: KeyedItem): PayableKey => ({ seller: i.seller, id: i.payable_id })
