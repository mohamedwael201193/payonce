import { describe, expect, it } from 'vitest'
import { AccountAddress } from '@concordium/web-sdk'
import { lookalike, sharedEnds, validChecksum } from './lookalike'

const A = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin'
describe('lookalike', () => {
  it('keeps the ends, changes the middle, and is a well-formed address', () => {
    expect(validChecksum(A)).toBe(true)
    const l = lookalike(A, { head: 6, tail: 2 })
    expect(l).not.toBeNull()
    const e = sharedEnds(A, l!)
    expect(e.head).toBeGreaterThanOrEqual(6)
    expect(e.tail).toBeGreaterThanOrEqual(2)
    expect(l).not.toBe(A)
    expect(() => AccountAddress.fromBase58(l!)).not.toThrow()
  })
  it('works for other accounts and changes only a few characters', () => {
    for (const a of ['42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', '3kBx2h5Y8v3TfqmRZ3BmvNwKUX4ZRVJcVLRsC9cBRwLX9pYgyR', A]) {
      const l = lookalike(a)
      if (!l) continue
      const d = [...a].filter((c, i) => c !== l[i]).length
      expect(d).toBeLessThanOrEqual(14)
      expect(validChecksum(l)).toBe(true)
    }
    expect(lookalike(A)).not.toBeNull()
    expect(lookalike('42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB')).not.toBeNull()
  })
  it('rejects a bad address', () => expect(lookalike('nope')).toBeNull())
})
