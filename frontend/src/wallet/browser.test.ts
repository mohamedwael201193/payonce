import { describe, expect, it, vi } from 'vitest'
import { moduleSchemaArg, sponsoredCall } from './browser'

// Concordium Wallet 2.12.x popup (SendSponsoredTransaction.tsx) rebuilds the schema with
// new Uint8Array(Object.values(schema.value)). A base64 string there yields garbage bytes and the
// render throws "Missing Schema Version", leaving popup.html blank. The value must be a byte array.
const B64 = '//8DAQAAABMAAABwYXlhYmxlX3JlZ2lzdHJ5X3Yz'

describe('sponsored transaction wallet arguments', () => {
  it('turns the base64 module schema into a Uint8Array, not a string', () => {
    const arg = moduleSchemaArg(B64) as { type: string; value: unknown }
    expect(arg.type).toBe('ModuleSchema')
    expect(arg.value).toBeInstanceOf(Uint8Array)
    expect(Array.from(arg.value as Uint8Array).slice(0, 4)).toEqual([0xff, 0xff, 0x03, 0x01])
    // what the wallet popup does after the chrome message boundary turns bytes into {0:..,1:..}
    const over = JSON.parse(JSON.stringify(arg)).value
    const rebuilt = new Uint8Array(Object.values(over))
    expect(rebuilt.length).toBe((arg.value as Uint8Array).length)
    expect(rebuilt[0]).toBe(0xff)
  })

  it('passes no schema when there is none', () => expect(moduleSchemaArg(null)).toBeUndefined())

  it('sends the account as a base58 string and the schema as bytes', async () => {
    const send = vi.fn(async () => 'hash')
    const acct = '4ANkHiBERTZUsU3HHy99hrQQbzrGJLzqBdkoqmW9pXFtb89MEL'
    const tx = {
      version: 1, signatures: { sender: {}, sponsor: { 0: { 0: 'ab'.repeat(64) } } },
      header: { sender: acct, nonce: 1, expiry: 1795861112, executionEnergyAmount: 2068, numSignatures: 1, sponsor: { account: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', numSignatures: 1 } },
      payload: { type: 'update', amount: '0', address: { index: 13173, subindex: 0 }, receiveName: 'payable_registry_v3.accept_payee', message: '00' },
    }
    await sponsoredCall({ sendSponsoredTransaction: send } as never, acct, tx, B64)
    const [a, , s] = send.mock.calls[0] as unknown as [unknown, unknown, { value: unknown }]
    expect(a).toBe(acct)
    expect(s.value).toBeInstanceOf(Uint8Array)
  })
})
