// Verification of Payee: name proof from the payee's own wallet + EPC-style name matching. Offline, stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayeeProofs, nameMatch, revealedAttributes, provenName } from '../src/payee-proof.mjs';

const A = '3S86n9LzC4H8NVYWASGpnUUaRpXxKgb4pdKkHM5EQAeYGRVvVN';
const OTHER = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
const CRED = 'a'.repeat(96);
const memKv = () => { const m = new Map(); return { get: async (n, k) => m.get(`${n}|${k}`) ?? null, put: async (n, k, v) => { m.set(`${n}|${k}`, v); } }; };

const v0pres = (first, last) => ({ verifiableCredential: [{ issuer: 'did:ccd:testnet:idp:0', credentialSubject: { id: `did:ccd:testnet:cred:${CRED}`, statement: [{ type: 'RevealAttribute', attributeTag: 'firstName' }, { type: 'RevealAttribute', attributeTag: 'lastName' }] }, proof: { proofValue: [{ type: 'RevealAttribute', attribute: first }, { type: 'RevealAttribute', attribute: last }] } }] });
const v1pres = (legal) => ({ verifiableCredential: [{ issuer: 'did:ccd:testnet:idp:3', credentialSubject: { id: `did:ccd:testnet:cred:${CRED}`, statement: [{ type: 'AttributeValue', attributeTag: 'legalName', attributeValue: legal }] } }] });

function make(over = {}) {
  let challenge = null;
  const p = createPayeeProofs({
    kv: memKv(), now: () => 1_000_000,
    anchorV1Request: async () => ({ request: { type: 'ConcordiumVerificationRequestV1' }, vra_tx: 'ab'.repeat(32) }),
    verifyV1: async () => ({ ok: true, vaa_tx: 'cd'.repeat(32) }),
    verifyV0: async () => ({ ok: true, challenge }),
    holderAccount: async () => A,
    ...over,
  });
  return { p, setChallenge: (c) => { challenge = c; } };
}

test('revealed attributes: V0 proofValue and V1 AttributeValue shapes', () => {
  assert.deepEqual(revealedAttributes(v0pres('Nour', 'Hassan')), { firstName: 'Nour', lastName: 'Hassan' });
  assert.deepEqual(revealedAttributes(v1pres('Nour Design Studio ApS')), { legalName: 'Nour Design Studio ApS' });
  assert.equal(provenName('person', { firstName: 'Nour', lastName: 'Hassan' }), 'Nour Hassan');
  assert.equal(provenName('business', {}), null);
});

test('name matching: match, close match, no match', () => {
  assert.equal(nameMatch('Nour Design Studio Ltd', 'NOUR DESIGN STUDIO').verdict, 'match');
  assert.equal(nameMatch('Hassan Nour', 'Nour Hassan').verdict, 'match');
  assert.equal(nameMatch('Nour Desing Studio', 'Nour Design Studio').verdict, 'close_match');
  assert.equal(nameMatch('Café Ñandú', 'Cafe Nandu').verdict, 'match');
  assert.equal(nameMatch('Acme Payments', 'Nour Design Studio').verdict, 'no_match');
  assert.equal(nameMatch('', 'x').verdict, 'no_match');
});

test('V0 (CryptoX): challenge + holder binding, then the name is filed and matched', async () => {
  const { p, setChallenge } = make();
  const r = await p.request({ account: A, kind: 'person', wallet: 'walletconnect' });
  assert.equal(r.v1, undefined, 'no VRA anchored for a WalletConnect wallet');
  assert.equal(r.v0.statements[0].statement.length, 2);
  setChallenge(r.v0.challenge);
  const v = await p.verify({ request_id: r.request_id, version: 'v0', presentation: JSON.stringify(v0pres('Nour', 'Hassan')) });
  assert.equal(v.verified, true, JSON.stringify(v.checks));
  assert.equal(v.proof.name, 'Nour Hassan');
  assert.equal((await p.match(A, 'Nour Hassan')).verdict, 'match');
  assert.equal((await p.match(A, 'Nour Hasan')).verdict, 'close_match');
  assert.equal((await p.match(A, 'Someone Else')).verdict, 'no_match');
  assert.equal((await p.match(OTHER, 'Nour Hassan')).verdict, 'unverified');
  await assert.rejects(p.verify({ request_id: r.request_id, version: 'v0', presentation: v0pres('Nour', 'Hassan') }), /already answered/);
});

test('V1 (Browser Wallet): anchored request, node verification, audit anchor', async () => {
  const { p } = make();
  const r = await p.request({ account: A, kind: 'business', wallet: 'browser' });
  assert.equal(r.vra_tx, 'ab'.repeat(32));
  const v = await p.verify({ request_id: r.request_id, version: 'v1', presentation: v1pres('Nour Design Studio ApS') });
  assert.equal(v.verified, true);
  assert.equal(v.proof.vaa_tx, 'cd'.repeat(32));
  assert.equal((await p.match(A, 'Nour Design Studio')).verdict, 'match');
});

test('a proof from another account, a wrong challenge or a failed verification files nothing', async () => {
  for (const [over, version, id] of [
    [{ holderAccount: async () => OTHER }, 'v0', 'holder'],
    [{ verifyV0: async () => ({ ok: true, challenge: 'f'.repeat(64) }) }, 'v0', 'challenge'],
    [{ verifyV1: async () => ({ ok: false, reason: 'bad proof' }) }, 'v1', 'verified'],
  ]) {
    const { p, setChallenge } = make(over);
    const r = await p.request({ account: A, kind: 'person', wallet: 'browser' });
    setChallenge(r.v0.challenge);
    const v = await p.verify({ request_id: r.request_id, version, presentation: v0pres('Nour', 'Hassan') });
    assert.equal(v.verified, false, id);
    assert.ok(v.checks.find((c) => c.id === id && c.status === 'fail'), id);
    assert.equal((await p.get(A)).proof, null);
  }
});
