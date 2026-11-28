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
