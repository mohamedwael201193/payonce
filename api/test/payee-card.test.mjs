import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayeeCards } from '../src/payee-card.mjs';

const BOOK = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const ACC = '3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ';
const NOW = 2_000_000;
const mk = ({ proof = null, rec = null } = {}) => {
  const seen = [];
  const cards = createPayeeCards({
    kv: { get: async () => proof },
    vop: { check: async (i) => { seen.push(i); return { verdict: 'MATCH', reasons: [] }; } },
    readBook: async () => rec, readAccount: async () => ({ exists: true }),
    bookSellers: [BOOK], now: () => NOW, appBase: 'https://app.test', apiBase: 'https://api.test',
  });
  return { cards, seen };
};

test('a verified, bound payee past its hold gets a full label', async () => {
  const { cards } = mk({ proof: { name: 'Acme ApS', kind: 'business', version: 1, verified_at: '2026-11-28' }, rec: { status: 'Bound', version: 2, mature_at_ms: NOW - 1, identity: { kind: 1, idp_index: 4 } } });
  const c = await cards.card(ACC);
  assert.equal(c.verified, true);
  assert.equal(c.label, 'Verified payee: Acme ApS · bound by the payee’s own signature · hold over · v2');
  assert.equal(c.links.page, `https://app.test/p/${ACC}`);
  assert.match(c.testnet_note, /self-asserted mock identities/);
});

test('still in the hold is not "hold over"; an account with no proof is Unverified', async () => {
  const { cards } = mk({ rec: { status: 'Bound', version: 1, mature_at_ms: NOW + 5000, identity: { kind: 0 } } });
  const c = await cards.card(ACC);
  assert.equal(c.verified, false); assert.equal(c.name, null);
  assert.equal(c.bound.hold_over, false);
  assert.ok(c.label.startsWith('Unverified payee'));
  assert.ok(!/hold over/.test(c.label));
});

test('a revoked or missing record is not a bound payee', async () => {
  const { cards } = mk({ rec: { status: 'Revoked', version: 3 } });
  const c = await cards.card(ACC);
  assert.equal(c.bound.status, 'Revoked');
  assert.ok(!/bound by/.test(c.label));
  assert.equal((await mk().cards.card(ACC)).bound, null);
});

test('bad addresses are refused; check uses the book seller and returns lower-case verdict', async () => {
  const { cards, seen } = mk({ rec: { status: 'Bound', version: 1, mature_at_ms: 1, identity: { kind: 0 } } });
  await assert.rejects(() => cards.card('nope'), (e) => e.status === 400);
  const r = await cards.check(ACC, 'Acme ApS');
  assert.equal(r.epc_verdict, 'match');
  assert.equal(seen[0].seller, BOOK); assert.equal(seen[0].payee, ACC); assert.equal(seen[0].legal_name, 'Acme ApS');
});

// QA R3c-4: a visitor binds on the 90 s demo book (<13173,0>), so /p must read that book too, not only the live one.
test('a payee bound only on an extra (demo) book is shown as Bound there and checked against that book', async () => {
  const seenLive = []; const seenDemo = [];
  const cards = createPayeeCards({
    kv: { get: async () => null },
    vop: { check: async (i) => { seenLive.push(i); return { verdict: 'UNVERIFIED', reasons: [] }; } },
    readBook: async () => null, readAccount: async () => ({ exists: true }),
    bookSellers: [BOOK], now: () => NOW, appBase: 'https://app.test', apiBase: 'https://api.test',
    extraBooks: [{ label: '<13173,0>', bookSellers: [BOOK], vop: { check: async (i) => { seenDemo.push(i); return { verdict: 'MATCH', payable: true, reasons: [] }; } },
      readBook: async () => ({ status: 'Bound', version: 1, mature_at_ms: NOW - 1, identity: { kind: 2 } }) }],
  });
  const c = await cards.card(ACC);
  assert.equal(c.bound.status, 'Bound'); assert.equal(c.bound.book, '<13173,0>'); assert.equal(c.bound.hold_over, true);
  assert.match(c.label, /bound by the payee’s own signature/);
  const r = await cards.check(ACC, 'Elin');
  assert.equal(r.payable, true); assert.equal(seenDemo.length, 1); assert.equal(seenLive.length, 0);
});

test('the primary book wins when it is Bound; extra books are only a fallback', async () => {
  const cards = createPayeeCards({
    kv: { get: async () => null }, vop: { check: async () => ({ verdict: 'MATCH', reasons: [] }) },
    readBook: async () => ({ status: 'Bound', version: 1, mature_at_ms: NOW - 1, identity: { kind: 0 } }), readAccount: async () => ({ exists: true }),
    bookSellers: [BOOK], now: () => NOW,
    extraBooks: [{ label: 'x', bookSellers: [BOOK], vop: { check: async () => { throw new Error('should not be used'); } }, readBook: async () => { throw new Error('should not be read'); } }],
  });
  const c = await cards.card(ACC);
  assert.equal(c.bound.book ?? null, null);
  assert.equal((await cards.check(ACC, 'x')).verdict, 'MATCH');
});

test('a bound payee includes the accept_payee hash from findBindTx', async () => {
  const HASH = 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701';
  const cards = createPayeeCards({
    kv: { get: async () => null }, vop: { check: async () => ({ verdict: 'MATCH', reasons: [] }) },
    readBook: async () => ({ status: 'Bound', version: 1, mature_at_ms: NOW - 1, identity: { kind: 2 } }),
    readAccount: async () => ({ exists: true }), bookSellers: [BOOK], now: () => NOW,
    findBindTx: async (account) => { assert.equal(account, ACC); return HASH; },
  });
  const c = await cards.card(ACC);
  assert.equal(c.bound.tx_hash, HASH);
});
