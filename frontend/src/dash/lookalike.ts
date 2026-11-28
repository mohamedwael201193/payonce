// An ILLUSTRATION of the attack, never a payee: a Concordium account address (base58check, version byte 1,
// 32-byte key hash, 4-byte checksum) whose first and last characters match the real one while the middle
// differs, because people check only the ends. It has a valid checksum and almost certainly does not exist on
// chain. Finding more than a few matching tail characters is a brute-force search (58^tail checksums).
import { sha256Bytes } from '../landing/sha256'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decode(s: string): Uint8Array | null {
  let n = 0n
  for (const ch of s) {
    const d = ALPHABET.indexOf(ch)
    if (d < 0) return null
    n = n * 58n + BigInt(d)
  }
  const out = new Uint8Array(37)
  for (let i = 36; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n }
  return n === 0n ? out : null
}

function encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  return s
}

function withChecksum(body: Uint8Array): Uint8Array {
  const sum = sha256Bytes(sha256Bytes(body)).slice(0, 4)
  const out = new Uint8Array(37)
  out.set(body)
  out.set(sum, 33)
  return out
}

/** True when the string is a well-formed account address with a correct checksum. */
export function validChecksum(addr: string): boolean {
  const b = decode(addr)
  if (!b || b[0] !== 1) return false
  const again = withChecksum(b.slice(0, 33))
  return again.every((x, i) => x === b[i])
}

export function sharedEnds(a: string, b: string): { head: number; tail: number } {
  let head = 0
  while (head < a.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { head, tail }
}

/** Keep the first `head` and last `tail` characters, change the middle. Returns null when none is found. */
export function lookalike(addr: string, { head = 6, tail = 2, minChanged = 8, maxTries = 400_000 } = {}): string | null {
  if (addr.length !== 50 || !validChecksum(addr)) return null
  const lo = head + 1
  const hi = addr.length - tail - 8 // never touch the checksum zone (the last ~6 characters)
  if (hi - lo < 4) return null
  let seed = 0x9e3779b9
  const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0; return (seed >>> 0) / 4294967296 }
  for (let t = 0; t < maxTries; t++) {
    const chars = [...addr]
    for (let k = 0; k < 6; k++) chars[lo + Math.floor(((k + rnd()) * (hi - lo)) / 6)] = ALPHABET[Math.floor(rnd() * 58)] // a few changed characters; the checksum zone changes by itself
    const b = decode(chars.join(''))
    if (!b || b[0] !== 1) continue
    const cand = encode(withChecksum(b.slice(0, 33)))
    if (cand.length !== 50 || !cand.startsWith(addr.slice(0, head)) || !cand.endsWith(addr.slice(addr.length - tail))) continue
    let diff = 0
    for (let i = 0; i < 50; i++) if (cand[i] !== addr[i]) diff++
    if (diff >= minChanged && diff <= 14 && validChecksum(cand)) return cand
  }
  return null
}
