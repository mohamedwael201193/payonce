import { describe, expect, it } from 'vitest'
import { plainEvent } from './agentRun'

describe('plainEvent', () => {
  it('turns raw run log lines into plain sentences', () => {
    expect(plainEvent('  tool_call check_payable')).toBe('Checking who it is paying (Match / No match)')
    expect(plainEvent('  tool_call pay_payable')).toMatch(/^Paying once/)
    expect(plainEvent('  guard pay_payable: Mandate guard passed: approved supplier')).toBe('Safety guard: Mandate guard passed: approved supplier')
    expect(plainEvent('  harness_note: re-reading')).toBe('Note: re-reading')
    expect(plainEvent('  tool_call some_new_tool')).toBe('Calling some new tool')
    expect(plainEvent('registering a fresh CCD invoice')).toBe('registering a fresh CCD invoice')
  })
})
