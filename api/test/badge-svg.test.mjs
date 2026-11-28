import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { badgeKind, badgeSvg, BADGE_WORD } from '../src/badge-svg.mjs';

describe('badge svg', () => {
  it('Match is the only green fill', () => {
    const green = '#e8f6ee';
    assert.match(badgeSvg('MATCH'), new RegExp(green));
    for (const k of ['CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED', 'NOT_BOUND', 'PROVEN', 'UNPROVEN']) {
      assert.doesNotMatch(badgeSvg(k), new RegExp(green));
      assert.match(badgeSvg(k), new RegExp(BADGE_WORD[k]));
    }
  });
  it('without a verdict, a proven name is not called Match', () => {
    assert.equal(badgeKind({ verdict: 'MATCH', payable: true }), 'MATCH');
    assert.equal(badgeKind({ verdict: 'MATCH', payable: false }), 'NOT_BOUND');
    assert.equal(badgeKind({ verified: true, named: true }), 'PROVEN');
    assert.equal(badgeKind({ verdict: 'UNVERIFIED' }), 'UNVERIFIED');
    assert.doesNotMatch(badgeSvg('PROVEN'), /Match/);
  });
});
