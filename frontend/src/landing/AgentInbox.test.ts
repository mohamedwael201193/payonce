import { describe, expect, it } from 'vitest'
import recorded from '../app/data/agentRun.json'
import { inboxRows, refusalWhy, supplierName, trimAmount } from './AgentInbox'
import type { AgentRun } from '../lib/agentRun'

describe('agent inbox rows', () => {
  it('names suppliers from the sender domain', () => {
    expect(supplierName('billing@alder-bakery.example')).toBe('Alder Bakery')
    expect(supplierName('finance@harbor-freight-co.example')).toBe('Harbor Freight CO')
  })
  it('trims trailing zeros, never integer zeros', () => {
    expect(trimAmount('0.500000 CCD')).toBe('0.5 CCD')
    expect(trimAmount('1.000000 CCD')).toBe('1 CCD')
    expect(trimAmount('10 CCD')).toBe('10 CCD')
    expect(trimAmount('0.01 EUDemo')).toBe('0.01 EUDemo')
  })
  it('maps the run record codes to one short reason', () => {
    expect(refusalWhy({ hostile_fixture: 'payee_change', reason_code: 'x', age_gate: null })).toBe('Asks to pay a different account')
    expect(refusalWhy({ hostile_fixture: null, reason_code: 'seller_known', age_gate: null })).toBe('Seller is not on your approved list')
    expect(refusalWhy({ hostile_fixture: 'tampered_document', reason_code: 'attachment_matches_chain', age_gate: null })).toBe('Invoice was edited after it went on chain')
  })
  it('puts refusals first and links paid rows to their receipt', () => {
    const rows = inboxRows(recorded as unknown as AgentRun)
    const firstPaid = rows.findIndex((r) => r.outcome === 'paid')
    expect(rows.slice(0, firstPaid).every((r) => r.outcome === 'refused')).toBe(true)
    for (const r of rows.filter((x) => x.outcome === 'paid')) expect(r.href).toMatch(/^\/app\/receipt\/\w+\/\d+$/)
  })
})
