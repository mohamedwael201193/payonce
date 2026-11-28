// G13 scorecard logic against a fake node: expected refusals pass, an accepted attack or a wrong code fails loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttackCatalogue, aliasOf } from '../src/vop-attacks.mjs';
import { serPayableKey } from '../src/vop-chain.mjs';

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const BUYER = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const X = '3GPTo1LQbwHcsxPLBmWAVAA4RF6FvbDkzbf7DvLkEKpxWMboHq';
const STRANGER = '3LgPU9K2WFg3ghFHXjm2r2Mizi2eqY71ENTWqHZL98h9ueFKMt';
const BOOK = { index: 13173n, subindex: 0n, name: 'payable_registry_v3' };

function fakeClient(codes) {
  return {
    async invokeContract({ method, invoker }) {
      const ep = method.toString().split('.')[1];
      if (ep === 'get_payable' || ep === 'get_payee') return { tag: 'success', returnValue: new Uint8Array([0]) }; // None
      const code = codes(ep, invoker.address);
      return code == null ? { tag: 'success', usedEnergy: { value: 900n } } : { tag: 'failure', usedEnergy: { value: 700n }, reason: { tag: 'RejectedReceive', rejectReason: code } };
    },
    async getBlockItemStatus() { return { status: 'finalized', outcome: { blockHash: 'b', summary: { rejectReason: { tag: 'RejectedReceive', rejectReason: -29 } } } }; },
  };
}
const table = { pay_ccd: -5, register_payable: -28, accept_payee: -32, revoke_payee: -35, acknowledge_payee: -36 };

test('attack catalogue: >= 25 attacks, codes compared exactly, accepted attacks fail', async () => {
  const cat = createAttackCatalogue({
    client: () => fakeClient((ep) => table[ep]), book: BOOK, seller: SELLER, buyer: BUYER, token: 1476n,
    fixtures: { X, Y: aliasOf(X, 1), stranger: STRANGER, staleInvoice: 123, paidInvoice: 122, recorded: { notMature: 'a'.repeat(64) } },
    check: async ({ legal_name, payee }) => (payee === SELLER && legal_name === 'PayOnce Labs' ? { verdict: 'MATCH', payable: true } : { verdict: legal_name === 'PayOnce Lab' ? 'CLOSE_MATCH' : 'NO_MATCH', payable: false }),
    payTx: async () => { const e = new Error('x'); e.code = 'needs_signed_approval'; throw e; },
    approvals: { request: async () => ({ approval_id: 'f'.repeat(24) }), verify: async () => { const e = new Error('x'); e.code = 'bad_signature'; throw e; } },
  });
  const r = await cat.run();
  assert.ok(r.total >= 25, `total ${r.total}`);
  const by = Object.fromEntries(r.attacks.map((a) => [a.id, a]));
  assert.equal(by['pay-twice'].pass, true); assert.equal(by['pay-twice'].got, '-5 WrongStatus');
  assert.equal(by['wrong-amount'].pass, false, '-5 is not the expected -6');
  assert.equal(by['unbound-payee-invoice'].pass, true);
  assert.equal(by['not-mature'].pass, true); assert.equal(by['not-mature'].tx_hash, 'a'.repeat(64));
  for (const id of ['lookalike-name', 'homoglyph-name', 'lookalike-address-check', 'impostor-account-check', 'click-approval', 'forged-approval-signature']) assert.equal(by[id].pass, true, id);
  assert.equal(r.passed + r.failed, r.total);
  const open = createAttackCatalogue({ client: () => fakeClient(() => null), book: BOOK, seller: SELLER, buyer: BUYER, token: 1476n, fixtures: { X, Y: aliasOf(X, 1), stranger: STRANGER, staleInvoice: 123, paidInvoice: 122 }, check: async () => ({ verdict: 'MATCH', payable: true }), payTx: async () => ({}), approvals: { request: async () => ({ approval_id: 'f'.repeat(24) }), verify: async () => ({ approved: true }) } });
  const r2 = await open.run();
  assert.equal(r2.passed, 0); assert.ok(r2.attacks.every((a) => a.got === 'ACCEPTED' || a.layer === 'api'));
  assert.ok(serPayableKey({ seller: SELLER, payable_id: 1 }).length === 40);
});
