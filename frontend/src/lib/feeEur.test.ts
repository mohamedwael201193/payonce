import { describe, expect, it } from 'vitest'
import { CCD_PER_EUR, EUR_PER_NRG, FEE_EUR_SOURCE, NRG, PAID_INVOICE_FEE_TEXT, eur, eurOfCcd, eurOfNrg } from './feeEur'

describe('fees in euros', () => {
  it('a sponsored payment of 2,518 NRG is about 5 cents at the on-chain price of energy', () => {
    expect(EUR_PER_NRG).toBe(0.00002)
    expect(NRG.pay_ccd * EUR_PER_NRG).toBeCloseTo(0.05036, 5)
    expect(eurOfNrg(NRG.pay_ccd)).toBe('€0.05')
  })
  it('the CCD figure and the euro figure agree within a cent at the chain CCD/EUR rate', () => {
    expect(Math.abs(20.1 / CCD_PER_EUR - NRG.pay_ccd * EUR_PER_NRG)).toBeLessThan(0.005)
    expect(eurOfCcd(22.495143)).toBe('€0.05')
  })
  it('never prints €0.00 for a real fee', () => {
    expect(eur(0.0004)).not.toBe('€0.00')
    expect(eur(0)).toBe('€0')
  })
  it('states the headline and the source with the date', () => {
    expect(PAID_INVOICE_FEE_TEXT).toBe('about 20 CCD (€0.05)')
    expect(FEE_EUR_SOURCE).toMatch(/euroPerEnergy/)
    expect(FEE_EUR_SOURCE).toMatch(/28 Nov 2026/)
    expect(FEE_EUR_SOURCE).toMatch(/no market value/)
  })
})
