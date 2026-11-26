import { describe, expect, it } from 'vitest'
import { ccdPayFeeSentence, CCD_PAY_FEE, formatDay, recordedLabel } from './fees'
import { parseKeyPath, payPath, receiptPath, resolveSeller, sellerName } from './keys'
import { tidyAmount } from './format'
import { paymentTxOf, verifierCommand } from './verifier'

const sellers = [
  { seller: 'AAA', label: 'Seller 1 — PayOnce Seller' },
  { seller: 'BBB', label: 'Seller 2 — PayOnce Seller 2' },
]

describe('seller key', () => {
  it('paths always carry the seller', () => {
    expect(payPath({ seller: 'AAA', id: 3 })).toBe('/app/pay/AAA/3')
    expect(receiptPath({ seller: 'BBB', id: 1 })).toBe('/app/receipt/BBB/1')
  })
  it('parses and rejects splats', () => {
    expect(parseKeyPath('AAA/3')).toEqual({ sellerParam: 'AAA', id: 3 })
    expect(parseKeyPath('AAA')).toBeNull()
    expect(parseKeyPath('AAA/3x')).toBeNull()
    expect(parseKeyPath('AAA/0')).toBeNull()
  })
  it('resolves address and 1/2 shorthand, nothing else', () => {
    expect(resolveSeller('BBB', sellers)).toBe('BBB')
    expect(resolveSeller('2', sellers)).toBe('BBB')
    expect(resolveSeller('9', sellers)).toBeNull()
    expect(resolveSeller('nope', sellers)).toBeNull()
    expect(sellerName('BBB', sellers)).toBe('Seller 2')
  })
})

describe('derived labels and one source of truth', () => {
  it('the recorded label takes its date from a timestamp, never a literal', () => {
    expect(recordedLabel('2026-11-26T03:41:30Z')).toBe('Recorded run, 26 Nov 2026')
    expect(recordedLabel(null)).toBe('Recorded run')
    expect(formatDay('2026-01-05')).toBe('05 Jan 2026')
  })
  it('one fee figure, from the recorded run data', () => {
    expect(CCD_PAY_FEE).toBe('16.2')
    expect(ccdPayFeeSentence()).toContain('16.2 testnet CCD')
    expect(ccdPayFeeSentence()).not.toContain('19.6')
  })
  it('one verifier command generator', () => {
    expect(verifierCommand({ payableId: 10, txHash: 'abc' })).toBe('node src/verify-payable-v2.mjs 10 abc')
    expect(verifierCommand({ payableId: 10, txHash: 'abc', docPath: 'd.txt' })).toBe('node src/verify-payable-v2.mjs 10 abc --doc d.txt')
    expect(paymentTxOf([{ label: 'Registered', tx_hash: 'r' }, { label: 'Payment', tx_hash: 'p' }])).toBe('p')
  })
  it('amounts are tidied', () => {
    expect(tidyAmount('0.500000 CCD')).toBe('0.5 CCD')
    expect(tidyAmount('10.00 EUDemo')).toBe('10 EUDemo')
  })
})
