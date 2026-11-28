import { describe, expect, it } from 'vitest'
import { correctionText, groundProse, recordedOutcome, type AgentDecision } from './agentRun'

const dec = (payable_id: number, outcome: string, extra: Partial<AgentDecision> = {}): AgentDecision =>
  ({ email_id: 'e', from: 'f', subject: 's', hostile_fixture: null, seller: 'S', payable_id, outcome, checks: [], ...extra }) as AgentDecision

const run = {
  decisions: [
    dec(1503, 'paid', { receipt: { verifier_reread: { passed: 14, total: 14 } } }),
    dec(1095, 'refused'),
    dec(1485, 'refused'),
  ],
  post_run_notes: [{ payable_id: 1485, text: 'confirmed by hand', confirm_tx: '43188ac7a4a8' }],
}

describe('groundProse', () => {
  it('marks "remains actionable" for a paid payable', () => {
    const c = groundProse('Invoice 1503 remains actionable once the proof is filed.', run)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ payable_id: 1503, says: 'not_paid', record: 'paid' })
    expect(correctionText(c[0], run)).toContain('verifier 14/14')
  })
  it('counts a confirm finished after the run as paid', () => {
    expect(recordedOutcome(run, 1485)).toBe('paid')
    const c = groundProse('The 1485 payment is in a limbo state.', run)
    expect(c[0]?.record).toBe('paid')
    expect(correctionText(c[0], run)).toContain('after the run')
  })
  it('marks a refused payable described as paid', () => {
    const c = groundProse('Payable 1095 was paid.', run)
    expect(c).toEqual([expect.objectContaining({ payable_id: 1095, says: 'paid', record: 'refused' })])
  })
  it('leaves correct sentences and mixed lists alone', () => {
    expect(groundProse('Payable 1503 was paid and its receipt verified.', run)).toEqual([])
    expect(groundProse('Payable 1095 was refused: the document was changed.', run)).toEqual([])
    expect(groundProse('Paid 1503; refused 1095 and 1485.', run)).toEqual([])
    expect(groundProse('Unknown payable 77 remains open.', run)).toEqual([])
  })
})
