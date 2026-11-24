// Recorded-run data — P3 §9 (refusals) and §14 (fees). Every value here must
// be traceable to the plan; no account addresses may appear (the staging
// copy's recorded.ts hardcodes an address — this file must never do that).
import { describe, expect, it } from 'vitest'
import { FEE_HEADLINE, RECORDED_FEES, RECORDED_REFUSALS } from './recorded'

const HEX64 = /^[0-9a-f]{64}$/
// A Concordium account address is 48 base58 chars; none may appear here.
const ACCOUNT_LIKE = /^[1-9A-HJ-NP-Za-km-z]{48}$/

describe('RECORDED_REFUSALS (P3 §9: 7 on-chain refusals)', () => {
  it('has exactly 7 refusals with unique codes', () => {
    expect(RECORDED_REFUSALS).toHaveLength(7)
    const codes = RECORDED_REFUSALS.map((r) => r.code)
    expect(new Set(codes).size).toBe(7)
    expect(codes.sort((a, b) => a - b)).toEqual([-17, -16, -13, -12, -6, -5, -3])
  })
  it('every hash is a full 64-hex tx hash with a plain-language reason', () => {
    for (const r of RECORDED_REFUSALS) {
      expect(r.txHash).toMatch(HEX64)
      expect(r.plain.length).toBeGreaterThan(20)
      expect(r.name).toMatch(/^[A-Z][A-Za-z]+$/)
    }
  })
  it('contains the two chain attacks the Try panel replays', () => {
    expect(RECORDED_REFUSALS.map((r) => r.code)).toContain(-5) // pay twice
    expect(RECORDED_REFUSALS.map((r) => r.code)).toContain(-6) // wrong amount
  })
  it('contains no account addresses', () => {
    for (const r of RECORDED_REFUSALS) {
      expect(r.txHash).not.toMatch(ACCOUNT_LIKE)
      expect(r.plain).not.toMatch(ACCOUNT_LIKE)
    }
  })
})

describe('RECORDED_FEES (P3 §14: from the log, not estimates)', () => {
  it('measured bars are positive; ranges have min < max', () => {
    for (const f of RECORDED_FEES) {
      if (f.state === 'measured') {
        expect(f.min).toBeGreaterThan(0)
        if (f.max !== null) expect(f.max).toBeGreaterThan(f.min)
      }
    }
  })
  it('the successful CCD payment fee is 16.205 (P3 §14)', () => {
    const pay = RECORDED_FEES.find((f) => f.step === 'Pay in CCD' && f.note === 'success')
    expect(pay?.min).toBe(16.205)
  })
  it('the successful reserve has NO number — "not measured"', () => {
    const reserve = RECORDED_FEES.find((f) => f.step === 'Reserve')
    expect(reserve?.state).toBe('not_measured')
    expect(reserve?.min).toBe(0)
  })
  it('the headline states the fee exceeds the invoice', () => {
    expect(FEE_HEADLINE).toContain('16.2 testnet CCD')
    expect(FEE_HEADLINE).toContain('0.5 CCD invoice')
    expect(FEE_HEADLINE).toContain('not mainnet estimates')
  })
})
