import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAcceptPayeeTx, createCcdscan, cachedBindTxFinder, bookAsString } from '../src/ccdscan.mjs';

const ACC = '4ANkHiBERTZUsU3HHy99hrQQbzrGJLzqBdkoqmW9pXFtb89MEL';
const HASH = 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701';
const payload = {
  data: {
    accountByAddress: {
      transactions: {
        nodes: [
          { transaction: { transactionHash: HASH, result: { events: { nodes: [{ __typename: 'ContractUpdated', receiveName: 'payable_registry_v3.accept_payee', contractAddress: { asString: '<13173,0>', index: 13173, subIndex: 0 } }] } } } },
          { transaction: { transactionHash: 'ab'.repeat(32), result: { events: { nodes: [{ __typename: 'AccountCreated' }] } } } },
        ],
      },
    },
  },
};

test('pickAcceptPayeeTx returns the newest accept_payee on the requested book', () => {
  assert.equal(bookAsString({ index: 13173, subindex: 0 }), '<13173,0>');
  assert.equal(pickAcceptPayeeTx(payload, { index: 13173, subindex: 0 }), HASH);
  assert.equal(pickAcceptPayeeTx(payload, '<13173,0>'), HASH);
  assert.equal(pickAcceptPayeeTx(payload, { index: 13172, subindex: 0 }), null);
  assert.equal(pickAcceptPayeeTx({ data: {} }, '<13173,0>'), null);
});

test('createCcdscan posts GraphQL and returns the hash; errors and timeouts become null', async () => {
  const calls = [];
  const api = createCcdscan({
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(await api.findAcceptPayeeTx(ACC, '<13173,0>'), HASH);
  assert.match(calls[0].body.query, /ContractUpdated/);
  assert.equal(calls[0].body.variables.a, ACC);
  const down = createCcdscan({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(await down.findAcceptPayeeTx(ACC, '<13173,0>'), null);
});

test('cachedBindTxFinder remembers a hash and does not call CCDScan again', async () => {
  const kv = new Map();
  const store = { get: async (ns, k) => kv.get(`${ns}|${k}`) ?? null, put: async (ns, k, v) => kv.set(`${ns}|${k}`, v) };
  let n = 0;
  const find = cachedBindTxFinder(async () => { n += 1; return HASH; }, store);
  assert.equal(await find(ACC, '<13173,0>'), HASH);
  assert.equal(await find(ACC, '<13173,0>'), HASH);
  assert.equal(n, 1);
});
