// Every command shape the app prints must be accepted by the real CLI's argument parser, and must carry the
// flags its payment needs: seller 2 needs --seller; an EUDemo payment needs --reserve and --confirm.
// (api/test/verify-command-shapes.test.mjs runs the CLI itself on the same shapes.)
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM without types, shared with the CLI
import { parseVerifyArgs } from '../../../api/src/verify-args.mjs'
import { receiptCommands, verifierCommand } from './verifier'

const H = (c: string) => c.repeat(64)
const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr'
const argvOf = (line: string) => line.trim().split(/\s+/).slice(2) // drop "node <script>"

describe('printed verifier commands parse with the real CLI parser', () => {
  const cases = [
    { name: 'seller 1 CCD', seller: S1, txs: [{ label: 'Payment', tx_hash: H('a') }] },
    { name: 'seller 2 CCD', seller: S2, txs: [{ label: 'Payment', tx_hash: H('b') }] },
    {
      name: 'seller 1 EUDemo',
      seller: S1,
      txs: [{ label: 'Reservation', tx_hash: H('1') }, { label: 'Transfer', tx_hash: H('2') }, { label: 'Confirm', tx_hash: H('3') }],
    },
    {
      name: 'seller 2 EUDemo',
      seller: S2,
      txs: [{ label: 'Reservation', tx_hash: H('4') }, { label: 'Transfer', tx_hash: H('5') }, { label: 'Confirm', tx_hash: H('6') }],
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const out = receiptCommands({ payableId: 7, seller: c.seller, sellerOne: S1, txs: c.txs, apiBase: 'https://api.example' })!
      const [fetchLine, runLine] = out.split('\n')
      expect(fetchLine).toContain(`/api/payables/7/document?seller=${c.seller}`)
      const a = parseVerifyArgs(argvOf(runLine))
      expect(a.payableId).toBe(7)
      expect(a.docPath).toMatch(/^invoice-/)
      if (c.seller === S2) expect(a.seller).toBe(S2)
      else expect(a.seller).toBeNull()
      if (c.name.includes('EUDemo')) {
        expect(a.txHash).toBe(c.txs[1].tx_hash) // the transfer, not the reservation
        expect(a.reserve).toBe(c.txs[0].tx_hash)
        expect(a.confirm).toBe(c.txs[2].tx_hash)
      } else {
        expect(a.reserve).toBeNull()
      }
    })
  }

  it('the judges page samples (payable 10 CCD, payable 11 EUDemo)', () => {
    const p10 = verifierCommand({ payableId: 10, txHash: H('c'), docPath: '../backend/test/invoices/invoice-010-v2-ccd.txt' })
    const p11 = verifierCommand({
      payableId: 11, txHash: H('d'), docPath: '../backend/test/invoices/invoice-011-v2-eudemo.txt', reserveTx: H('e'), confirmTx: H('f'),
    })
    expect(parseVerifyArgs(argvOf(p10)).reserve).toBeNull()
    const a = parseVerifyArgs(argvOf(p11))
    expect(a.reserve).toBe(H('e'))
    expect(a.confirm).toBe(H('f'))
  })
})
