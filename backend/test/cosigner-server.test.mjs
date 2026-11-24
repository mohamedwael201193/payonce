// PayOnce backend — co-signer service tests (C-35 + sign flow).
// Uses an EPHEMERAL ed25519 key (generateSigner) — no real key anywhere.
// The valid transfer case reuses the live v1 transfer values (payable 2,
// agent C3, seller B as sponsor, 300 s window) with a test digest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCosignerServer } from '../src/cosigner/server.mjs';
import { generateSigner, signDigest, verifyDigest } from '../src/cosigner/signer.mjs';
import { loadLedger } from '../src/cosigner/ledger.mjs';
import { encodeCborMemo } from '../src/chain.mjs';

const C3 = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n';
const SELLER_B = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const PAYEE2 = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const EXPIRES_MS = Date.parse('2026-11-24T04:56:31.593Z');
const DUE_MS = Date.parse('2026-11-25T04:49:31.426Z');
const DIGEST = createHash('sha256').update('payonce-cosigner-test-digest').digest('hex');

function snapshot() {
  return {
    version: 1,
    blockHash: 'eacbb02dc1f87d2232ce35b28681f9f04f1c1629353fa2be7a73144b0eeb54fc',
    slotTime: '2026-11-24T04:52:00.000Z',
    agentAccount: C3,
    sponsorAccount: SELLER_B,
    nextNonce: 42,
    agentStatus: 'Active',
    eudemoBalance: '44540000',
    payable: {
      seller: SELLER_B, id: 2, payee: PAYEE2, amount: '10000', asset: 'PLT',
      dueMs: String(DUE_MS), status: 'Reserved', payer: C3, expiresMs: String(EXPIRES_MS),
      expectedPayer: C3, legalRef: 'TEST-ONLY',
    },
    approval: { tier: 'test', legalRef: 'TEST-ONLY', perPayableCap: '1000000', periodCap: '10000000', periodSecs: 86400 },
    usage: '0',
    memoScan: { found: false, txHash: null },
    usedTxHashes: [],
    transfer: null,
  };
}
function transferReq(over = {}) {
  return {
    kind: 'transfer', sender: C3, nonce: 42, txVersion: 1, sponsor: SELLER_B,
    recipient: PAYEE2, amount: '10000', token: 'EUDemo',
    memo: encodeCborMemo('payable:2').toString('hex'),
    headerExpirySeconds: Math.floor((EXPIRES_MS - 60_000) / 1000),
    operations: 1,
    ...over,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'payonce-cosigner-'));
const ledgerPath = join(dir, 'ledger.jsonl');
const signer = generateSigner();
let server;
let port;

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  server = createCosignerServer({ signer, ledgerPath });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('signer: sign + verify round-trip on a test digest', () => {
  const sig = signDigest(signer, DIGEST);
  assert.equal(sig.length, 128);
  assert.equal(verifyDigest(signer.publicKey, DIGEST, sig), true);
  assert.equal(verifyDigest(signer.publicKey, '00'.repeat(32), sig), false);
});

test('/health reports the public key, never the secret', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.publicKey, signer.publicKey);
  assert.ok(!JSON.stringify(body).includes('private'));
});

test('/decide: valid transfer -> SIGN', async () => {
  const { status, body } = await post('/decide', { snapshot: snapshot(), request: transferReq() });
  assert.equal(status, 200);
  assert.equal(body.decision, 'SIGN');
});

test('/sign happy path: signature returned AND ledger entry written first', async () => {
  const { status, body } = await post('/sign', {
    snapshot: snapshot(), request: transferReq(), digest: DIGEST,
    txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef',
  });
  assert.equal(status, 200);
  assert.equal(body.decision, 'SIGN');
  assert.equal(body.signature.length, 128);
  assert.equal(verifyDigest(signer.publicKey, DIGEST, body.signature), true);
  assert.ok(existsSync(ledgerPath));
  const entries = loadLedger(ledgerPath).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'transfer');
  assert.equal(entries[0].payableKey, `${SELLER_B}:2`);
  assert.equal(entries[0].state, 'unresolved');
  assert.equal(entries[0].txHash, '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef');
});

test('/sign: a refusing request returns 403 and writes NO ledger entry', async () => {
  const before = loadLedger(ledgerPath).entries.length;
  const { status, body } = await post('/sign', {
    snapshot: snapshot(), request: transferReq({ amount: '10001' }), digest: DIGEST,
  });
  assert.equal(status, 403);
  assert.equal(body.decision, 'REFUSE');
  assert.equal(body.code, 'wrong-amount');
  assert.ok(!('signature' in body));
  assert.equal(loadLedger(ledgerPath).entries.length, before);
});

test('C-35: ledger write failure -> REFUSE with ledger-write-failed, NO signature', async () => {
  const badLedger = join(dir, 'no-such-dir', 'ledger.jsonl'); // parent does not exist
  const badServer = createCosignerServer({ signer, ledgerPath: badLedger });
  await new Promise((r) => badServer.listen(0, '127.0.0.1', r));
  const badPort = badServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${badPort}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: snapshot(), request: transferReq(), digest: DIGEST }),
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.decision, 'REFUSE');
    assert.equal(body.code, 'ledger-write-failed');
    assert.ok(!('signature' in body));
  } finally {
    badServer.close();
  }
});

test('recheck: the signed transfer entry resolves against the live chain', async () => {
  // The ledger now holds the live 7cc2f94f transfer; recheck must resolve it.
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['src/cosigner/recheck.mjs', '--ledger', ledgerPath], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  assert.match(out, /1 resolved/);
  assert.match(out, /4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs:2: resolved/);
  assert.match(out, /0 pending\/no-tx-hash/);
});
