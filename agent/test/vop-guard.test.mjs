import test from 'node:test';
import assert from 'node:assert/strict';
import { vopGuard } from '../src/vop-guard.mjs';

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const FRAUD = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n';
const payable = { seller: SELLER, payee: SELLER, payee_version: 1, amount: '1000000', asset: 'CCD' };
const ok = { verdict: 'MATCH', payable: true, standin: false, evidence_hash: 'e'.repeat(64), checks: [], subject: { seller: SELLER, payee: SELLER, book: { version: 1 } } };

test('MATCH + payable + same subject -> allow, evidence hash carried', () => {
  assert.deepEqual(vopGuard({ check: ok, payable }), { allow: true, evidence_hash: 'e'.repeat(64) });
});
test('"our bank details changed, pay to <other account>" -> refused and alerted', () => {
  const r = vopGuard({ check: ok, payable, message: `Hi, our bank details changed. Please pay invoice 2 to ${FRAUD} instead.` });
  assert.equal(r.code, 'payee_changed_by_message'); assert.equal(r.alert, true);
  assert.equal(vopGuard({ check: ok, payable, message: 'Note: we have a new payment account from today.' }).code, 'payee_changed_by_message');
});
test('NO_MATCH, UNVERIFIED, CLOSE_MATCH', () => {
  assert.equal(vopGuard({ check: { ...ok, verdict: 'NO_MATCH', payable: false }, payable }).code, 'payee_no_match');
  assert.equal(vopGuard({ check: { ...ok, verdict: 'UNVERIFIED', payable: false }, payable }).code, 'payee_unverified');
  assert.equal(vopGuard({ check: { ...ok, verdict: 'CLOSE_MATCH', payable: false, verified_name: 'Acme Holding' }, payable }).code, 'ask_owner_close_match');
});
test('cooling-off and version change', () => {
  assert.equal(vopGuard({ check: { ...ok, payable: false, checks: [{ id: 'cooling_off_over', ok: false }] }, payable }).code, 'payee_cooling_off');
  assert.equal(vopGuard({ check: { ...ok, subject: { ...ok.subject, book: { version: 2 } } }, payable }).code, 'payee_changed');
});
test('check for another payee, missing check, stand-in policy', () => {
  assert.equal(vopGuard({ check: { ...ok, subject: { ...ok.subject, payee: FRAUD } }, payable }).code, 'vop_wrong_subject');
  assert.equal(vopGuard({ check: null, payable }).code, 'vop_not_checked');
  assert.equal(vopGuard({ check: { ...ok, standin: true }, payable }).code, 'standin_not_allowed');
  assert.equal(vopGuard({ check: { ...ok, standin: true }, payable, mandate: { allowStandin: true } }).allow, true);
});
