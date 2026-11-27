import { describe, expect, it } from 'vitest'
import { AGENTS, badgeCheckUrl, badgeResultText, parseBadgeCheck } from './identity'

const goodBody = {
  badge_valid: true,
  on_chain: { status: 'Active', agent_uri: 'https://x/y.json' },
  checks: { ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`c${i}`, true])), badge_embedding: 'extension' },
  issues: [],
}

describe('parseBadgeCheck', () => {
  it('is valid only when badge_valid is true, and counts the checks', () => {
    const r = parseBadgeCheck(goodBody)
    expect(r).toMatchObject({ state: 'valid', passed: 15, total: 15, status: 'Active' })
    expect(badgeResultText(r)).toMatch(/^Verified by Concordium: badge_valid true, 15\/15/)
  })
  it('never says verified for a false badge', () => {
    const r = parseBadgeCheck({ ...goodBody, badge_valid: false, checks: { a: true, b: false }, issues: [{ message: 'no agent_uri set on chain' }] })
    expect(r).toMatchObject({ state: 'invalid', passed: 1, total: 2 })
    expect(badgeResultText(r)).not.toMatch(/Verified by Concordium/)
    expect(badgeResultText(r)).toMatch(/no agent_uri/)
  })
  it('reads an unreadable body as an error, not as valid', () => {
    expect(parseBadgeCheck(null).state).toBe('error')
    expect(parseBadgeCheck({ badge_valid: 'true' }).state).toBe('error')
    expect(badgeResultText({ state: 'idle' })).toBe('')
  })
})

describe('agents', () => {
  it('lists the two sellers and the payer on the official registry tokens', () => {
    expect(AGENTS.map((a) => a.token)).toEqual([1476, 1506, 1488])
    expect(badgeCheckUrl(AGENTS[0].badge)).toBe('https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a?network=testnet')
  })
})
