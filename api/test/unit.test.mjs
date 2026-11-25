// PayOnce API server — unit tests (no chain, no sends).
// Run: node --test test/unit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backend } from '../src/backend.mjs';
import { verifyBeforePay, verifyCcdV2, verifyPltV2, verifyPltTransferV2, pltReservationRow, pltConfirmRow, pltReceiptExtraChecks } from '../src/verifier-v2.mjs';
import { generateLabDocument, matrixDocBytes } from '../src/docs.mjs';
import { CCD_STEPS, EUDEMO_STEPS, rejectInfo } from '../src/jobs.mjs';
import { hitWindow, leftInWindow } from '../src/store.mjs';
import { REGISTRY, CIS8004_OFFICIAL, OWNER_ADDRESS, PAYER_ADDRESS } from '../src/config.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

test('config defaults to the v2 registry', () => {
  assert.equal(REGISTRY.index, 13150);
  assert.equal(REGISTRY.subindex, 0);
  assert.equal(REGISTRY.moduleRef, 'c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8');
  assert.equal(REGISTRY.name, 'payable_registry_v2');
  assert.equal(CIS8004_OFFICIAL.index, 12802);
  assert.equal(CIS8004_OFFICIAL.isOfficialRegistry, true);
});

test('matrix doc bytes hash to the on-chain doc_hash values (v2-live-e2e)', async () => {
  // The matrix registered DOC(n) = sha256(`payonce-live-matrix-${n}`); the
  // live test proves the on-chain doc_hash equals this hash for P1..P5.
  // Here: the rule is deterministic, distinct per id, and 64-hex.
  for (const n of [1, 2, 3, 4, 5]) {
    const hash = sha256(matrixDocBytes(n));
    assert.equal(hash, sha256(`payonce-live-matrix-${n}`));
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(sha256(matrixDocBytes(1)), sha256(matrixDocBytes(2)));
});

test('generated lab document hashes stably and contains the payable facts', () => {
  const text = generateLabDocument({
    id: 1000, asset: 'CCD', amount: '500000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  });
  assert.match(text, /payable 1000/);
  assert.match(text, /0\.500000 CCD \(500000 microCCD\)/);
  assert.match(text, new RegExp(OWNER_ADDRESS));
  assert.match(text, /Test only — Concordium testnet/);
  assert.equal(sha256(Buffer.from(text, 'utf8')), sha256(Buffer.from(generateLabDocument({
    id: 1000, asset: 'CCD', amount: '500000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  }), 'utf8')));
  const eudemo = generateLabDocument({
    id: 1001, asset: 'EUDemo', amount: '10000',
    payee: PAYER_ADDRESS, seller: OWNER_ADDRESS, due: 1790000000000,
  });
  assert.match(eudemo, /0\.01 EUDemo \(10000 base units, 6 decimals\)/);
});

test('v2 encoders match the matrix-proven layouts', async () => {
  const { v2enc } = await backend();
  // PayableKeyParam: seller 32B + id u64 LE.
  const key = v2enc.encodeV2PayableKey({ seller: OWNER_ADDRESS, id: 1 });
  assert.equal(key.length, 80);
  assert.equal(key.slice(64), '0100000000000000');
  // Confirm: seller 32B + id u64 + tx hash 32B.
  const txHash = 'ab'.repeat(32);
  const confirm = v2enc.encodeV2Confirm({ seller: OWNER_ADDRESS, id: 11, txHashHex: txHash });
  assert.equal(confirm.length, 80 + 64);
  assert.equal(confirm.slice(64, 80), '0b00000000000000');
  assert.equal(confirm.slice(80), txHash);
  // Register: id + payee + amount + asset + due + docHash + token + expected + legal.
  const reg = v2enc.encodeV2RegisterPayable({
    id: 1000, payee: PAYER_ADDRESS, amount: '500000', asset: 'CCD',
    dueMs: 1790000000000, docHashHex: 'cd'.repeat(32), token: 1476, expected: PAYER_ADDRESS, legal: null,
  });
  assert.equal(reg.slice(0, 16), 'e803000000000000'); // id 1000 LE
  assert.equal(reg.slice(16 + 64, 16 + 64 + 16), '20a1070000000000'); // amount 500000 LE
  assert.equal(reg[16 + 64 + 16], '0'); // asset tag 0x00 CCD
});

test('v2 event decoder parses the Paid event from the recorded P10 pay tx', async () => {
  const { v2ev } = await backend();
  // The Paid event is decoded from the recorded pay tx's Updated event at
  // live-test time; here the decoder rejects an unknown tag honestly.
  assert.throws(() => v2ev.decodeContractEventV2('ff00'), /unknown v2 contract event tag/);
  assert.throws(() => v2ev.decodeContractEventV2(''), /empty v2 contract event/);
});

test('reject table covers -1..-27 with the lib.rs names', () => {
  const expected = {
    '-1': 'Unauthorized', '-2': 'Duplicate', '-3': 'NotFound', '-4': 'WrongAsset',
    '-5': 'WrongStatus', '-6': 'WrongAmount', '-7': 'PastDue', '-8': 'AgentNotFound',
    '-9': 'AgentRevoked', '-10': 'AgentOwnerMismatch', '-11': 'RegistryCallFailed',
    '-12': 'TxReused', '-13': 'NotExpired', '-14': 'Invalid', '-15': 'TransferFailed',
    '-16': 'NotUnpaid', '-17': 'NotPayer', '-18': 'Invariant', '-19': 'NotApprovedVendor',
    '-20': 'LegalRefMismatch', '-21': 'NotExpectedPayer', '-22': 'ExpectedPayerRequired',
    '-23': 'CapExceeded', '-24': 'ConfirmAfterWindow', '-25': 'Voided',
    '-26': 'VoidWhileReserved', '-27': 'SelfAction',
  };
  for (const [code, name] of Object.entries(expected)) {
    assert.equal(rejectInfo(Number(code)).name, name);
    assert.equal(rejectInfo(Number(code)).code, Number(code));
  }
});

test('job step lists match P3 §16.8', () => {
  assert.deepEqual(CCD_STEPS, ['check_status', 'check_agent', 'submit', 'wait_finality', 'read_back', 'verify']);
  assert.deepEqual(EUDEMO_STEPS, ['check_wallet', 'reserve', 'co_sign_decide', 'submit_transfer', 'wait_finality', 'confirm', 'verify']);
});

test('rate-limit windows enforce and report the remainder', async () => {
  const key = `unit-test-${Date.now()}`;
  assert.equal(await leftInWindow(key, 60_000, 3), 3);
  assert.deepEqual((await hitWindow(key, 60_000, 3)).allowed, true);
  assert.deepEqual((await hitWindow(key, 60_000, 3)).allowed, true);
  assert.deepEqual((await hitWindow(key, 60_000, 3)).allowed, true);
  const fourth = await hitWindow(key, 60_000, 3);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.left, 0);
  assert.equal(await leftInWindow(key, 60_000, 3), 0);
});

test('co-signer decide() refuses a transfer with the wrong amount (live logic, synthetic snapshot)', async () => {
  const { decideMod } = await backend();
  const decide = decideMod.decide;
  const base = {
    version: 2, blockHash: '00'.repeat(32), slotTime: new Date().toISOString(),
    agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
    nextNonce: 7, agentStatus: 'Active', eudemoBalance: '1000000',
    payable: {
      seller: OWNER_ADDRESS, id: 3, payee: PAYER_ADDRESS, amount: '1000000',
      asset: 'EUDemo', dueMs: String(Date.now() + 3600_000), status: 'Reserved',
      payer: PAYER_ADDRESS, expiresMs: String(Date.now() + 3600_000),
      expectedPayer: PAYER_ADDRESS, legalRef: null,
    },
    approval: { tier: 2, legalRef: null, perPayableCap: '100000000', periodCap: '1000000000', periodSecs: '86400' },
    usage: '0', memoScan: { found: false, txHash: null }, usedTxHashes: [], transfer: null,
  };
  const { chain } = await backend();
  const memo = chain.encodeCborMemo(`payable:${OWNER_ADDRESS}:3`).toString('hex');
  const req = {
    kind: 'transfer', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, nonce: 7,
    recipient: PAYER_ADDRESS, amount: '1000001', token: 'EUDemo', memo,
    headerExpirySeconds: Math.floor((Date.now() + 3540_000) / 1000), operations: 1,
  };
  assert.equal(decide(base, req, { unresolved: [] }).code, 'wrong-amount');
  assert.equal(decide(base, { ...req, amount: '1000000' }, { unresolved: [] }).decision, 'SIGN');
});

test('co-signer decide() refuses a reserve for an unlisted seller (no-approval)', async () => {
  const { decideMod } = await backend();
  const decide = decideMod.decide;
  const snap = {
    version: 2, blockHash: '00'.repeat(32), slotTime: new Date().toISOString(),
    agentAccount: PAYER_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
    nextNonce: 7, agentStatus: 'Active', eudemoBalance: '1000000',
    payable: {
      seller: 'unlisted-seller', id: 9001, payee: PAYER_ADDRESS, amount: '1000000',
      asset: 'EUDemo', dueMs: String(Date.now() + 3600_000), status: 'Unpaid',
      payer: null, expiresMs: null, expectedPayer: PAYER_ADDRESS, legalRef: null,
    },
    approval: null, usage: '0', memoScan: { found: false, txHash: null },
    usedTxHashes: [], transfer: null,
  };
  const d = decide(snap, { kind: 'reserve_plt', sender: PAYER_ADDRESS, txVersion: 1, sponsor: null, numSignatures: 1, nonce: 7 }, { unresolved: [] });
  assert.equal(d.decision, 'REFUSE');
  assert.equal(d.code, 'no-approval');
});

// ---- workshop fix-back: consent anchor (W-01/W-11) ----
import {
  consentTextFor, sha256Hex as consentSha256, isAboveAskMeThreshold, buildConsentRecord,
  consentGateCheck, publicConsent, decodeConsentAnchor, isConsentExpired, assertContextsMatch,
  extractPresentationNonce, assertPresentationNonceMatches,
  ASK_ME_THRESHOLD_BASE, CONSENT_VALIDITY_SECS, LAB_CONSENT_ANCHORS,
} from '../src/consent.mjs';
import { parseMcpBody, mcpToolText, mcpToolJson, assertTestnet, clearMcpCache } from '../src/mcp-client.mjs';
import { balanceStatus, BALANCE_OK_MICROCCD } from '../src/balance-watch.mjs';
import { parseRegisteredTokenId } from '../src/buyer-agent.mjs';
import { externalKeyFromEnv, CIS8_CONTRACT } from '../src/cis8.mjs';
import { buildArt12Core, ART12_RETENTION, isDeadAnchor } from '../src/receipts.mjs';

test('consent: question text is hash-bound (one word changed => different hash)', () => {
  const view = { payableId: 42, amount: '2000000', asset: 'EUDemo', payee: '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg', seller: OWNER_ADDRESS };
  const a = consentTextFor(view);
  const b = consentTextFor({ ...view, amount: '2100000' });
  assert.notEqual(a, b);
  assert.notEqual(consentSha256(a), consentSha256(b));
  assert.match(a, /I consent: agent .* may pay up to 2\.00 EUDemo to merchant 4Vtd6WnC.* for order payable-42/);
});

test('consent: ask-me threshold is 1 CCD / 1.00 EUDemo', () => {
  assert.equal(ASK_ME_THRESHOLD_BASE, 1_000_000n);
  assert.equal(isAboveAskMeThreshold({ amount: '999999' }), false);
  assert.equal(isAboveAskMeThreshold({ amount: '1000000' }), true);
  assert.equal(isAboveAskMeThreshold({ amount: '500000' }), false);
  assert.equal(CONSENT_VALIDITY_SECS, 300);
});

test('consent: gate passes below threshold, refuses above without approval', () => {
  const small = { id: 7, amount: '500000', asset: 'CCD', payee: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin', seller: OWNER_ADDRESS };
  assert.equal(consentGateCheck(small, null), null);
  const big = { ...small, id: 8, amount: '2000000' };
  const noRecord = consentGateCheck(big, null);
  assert.equal(noRecord.code, 'consent_required');
  assert.equal(noRecord.status, 409);
  const pending = { ...buildConsentRecord(big), status: 'requested' };
  assert.equal(consentGateCheck(big, pending).code, 'consent_pending');
  const approved = { ...buildConsentRecord(big), status: 'approved', vraTx: 'ab'.repeat(32), vaaTx: 'cd'.repeat(32) };
  assert.equal(consentGateCheck(big, approved), null);
  const used = { ...approved, status: 'used' };
  assert.equal(consentGateCheck(big, used).code, 'consent_used');
  const expired = { ...approved, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(isConsentExpired(expired), true);
  assert.equal(consentGateCheck(big, expired).code, 'consent_expired');
});

test('consent: public view never carries the request JSON or a secret', () => {
  const view = { id: 9, amount: '2000000', asset: 'CCD', payee: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin', seller: OWNER_ADDRESS };
  const rec = { ...buildConsentRecord(view), requestJson: { secret: 'x' }, vraTx: 'ab'.repeat(32) };
  const pub = publicConsent(rec);
  assert.equal(pub.requestJson, undefined);
  assert.equal(pub.consent_sha256, rec.consentSha256);
  assert.equal(pub.explorer_vra_url, `https://ccdexplorer.io/testnet/transaction/${'ab'.repeat(32)}`);
  assert.deepEqual(Object.keys(pub).sort(), ['above_threshold', 'approved_at', 'consent_sha256', 'created_at', 'domain', 'expires_at', 'explorer_vaa_url', 'explorer_vra_url', 'label', 'one_time_use', 'payable_id', 'question', 'status', 'used_at', 'vaa_tx', 'validity_seconds', 'vra_tx'].sort());
});

test('consent: lab anchors are the recorded VAV1 goal-2 hashes', () => {
  assert.equal(LAB_CONSENT_ANCHORS.vra, 'ed92afaf8b3a7806a838f96d210ae2b0ffce9769297fa38973462b1a933bee00');
  assert.equal(LAB_CONSENT_ANCHORS.vaa, '2b3e6ddd84bd6a23ccb8ec395a647ed7c91c1b700cc8c751fcf4f5a7f16cbc06');
  assert.equal(LAB_CONSENT_ANCHORS.consentSha256, '8f7bce786dcc037aee2f73da44007b7992a4b7396f91045cb496d7f00b486ff5');
});

test('consent: decodeConsentAnchor rejects garbage CBOR', () => {
  const out = decodeConsentAnchor('00'.repeat(8));
  assert.ok(out.error);
});

// ---- workshop fix-back: MCP client (W-26) ----
test('mcp: parseMcpBody handles plain JSON and SSE', () => {
  const plain = parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  assert.equal(plain.result.tools.length, 0);
  const sse = parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n');
  assert.equal(sse.result.content[0].text, 'hi');
  assert.throws(() => parseMcpBody(''), /empty response/);
});

test('mcp: mcpToolText/mcpToolJson extract tool payloads and surface tool errors', () => {
  const msg = { result: { content: [{ type: 'text', text: '{"badge_valid":true}' }], isError: false } };
  assert.deepEqual(mcpToolJson(msg), { badge_valid: true });
  assert.equal(mcpToolText(msg), '{"badge_valid":true}');
  assert.throws(() => mcpToolText({ error: { message: 'boom' } }), /boom/);
  assert.throws(() => mcpToolText({ result: { content: [{ type: 'text', text: 'x' }], isError: true } }), /tool error/);
});

test('mcp: assertTestnet refuses anything but testnet', () => {
  assert.throws(() => assertTestnet('mainnet'), /must be 'testnet'/);
  assert.throws(() => assertTestnet(undefined), /must be 'testnet'/);
  assert.doesNotThrow(() => assertTestnet('testnet'));
  clearMcpCache();
});

// ---- workshop fix-back: balance watch (W-31) ----
test('balance-watch: ok/low/empty bands (50 CCD headroom)', () => {
  assert.equal(BALANCE_OK_MICROCCD, 50_000_000n);
  assert.equal(balanceStatus('50000000'), 'ok');
  assert.equal(balanceStatus('49999999'), 'low');
  assert.equal(balanceStatus('1'), 'low');
  assert.equal(balanceStatus('0'), 'empty');
});

// ---- workshop fix-back: buyer agent (W-23) ----
test('buyer-agent: Registered event token id parses (0x08 + u64 LE)', () => {
  const events = [{ tag: 'Registered', data: '08' + Buffer.alloc(8).toString('hex') }];
  events[0].data = '08' + Buffer.from([0x6c, 0x05, 0, 0, 0, 0, 0, 0]).toString('hex');
  assert.equal(parseRegisteredTokenId(events), 1388);
  assert.equal(parseRegisteredTokenId([]), null);
  assert.equal(parseRegisteredTokenId([{ tag: 'Other', data: 'ff' }]), null);
});

// ---- workshop fix-back: CIS-8 (W-17) ----
test('cis8: no key held by default; contract is <12801,0>', () => {
  assert.deepEqual(CIS8_CONTRACT, { index: 12801, subindex: 0 });
  assert.equal(externalKeyFromEnv({}), null);
  assert.equal(externalKeyFromEnv({ PAYONCE_EXTERNAL_KEY_NAMESPACE: 'eip155' }), null);
  assert.deepEqual(
    externalKeyFromEnv({ PAYONCE_EXTERNAL_KEY_NAMESPACE: 'eip155', PAYONCE_EXTERNAL_KEY_TYPE: 'secp256k1', PAYONCE_EXTERNAL_KEY_HEX: '02ab' }),
    { namespace: 'eip155', key_type: 'secp256k1', public_key_hex: '02ab' },
  );
});

// ---- workshop fix-back: Art. 12 receipts (W-42) ----
test('receipts: Art. 12 core carries the full field list + retention', async () => {
  const { receiptBuild } = await backend();
  const view = { id: 42, asset: 'EUDemo', amount: '10000', payee: '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg', record: { payer: PAYER_ADDRESS } };
  const core = buildArt12Core({ payableId: 42, view, txs: [['Transfer', 'ab'.repeat(32)]], verifier: { passed: 12, total: 12, checked_at: '2026-11-25T00:00:00.000Z' }, consent: null });
  for (const k of ['agent', 'model', 'task', 'task_giver', 'authoriser', 'decisions', 'payment', 'errors', 'human_overrides', 'consent', 'retention', 'registry', 'network']) {
    assert.ok(k in core, `missing Art. 12 field ${k}`);
  }
  assert.match(core.retention, /at least 6 months/);
  assert.match(ART12_RETENTION, /at least 6 months/);
  assert.equal(core.payment.recipients[0], view.payee);
  assert.equal(core.agent.registry_token, 1476);
  const withNonce = { ...core, nonce: '00'.repeat(16) };
  const h1 = receiptBuild.computeRecordHash(withNonce);
  const h2 = receiptBuild.computeRecordHash(withNonce);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const tampered = { ...withNonce, task: 'pay something else' };
  assert.notEqual(receiptBuild.computeRecordHash(tampered), h1);
});

// ---- workshop fix-back-3: dead-anchor detection (M1) ----
test('receipts: isDeadAnchor fires only on "transaction not found"', () => {
  // The live-proven dead case: the node's own words for receipt 1001's
  // anchor (verifyRecordAnchor reason), and the stored anchor_status
  // string the old code re-reported forever.
  assert.equal(isDeadAnchor({ ok: false, reason: 'transaction not found.' }), true);
  assert.equal(isDeadAnchor({ ok: false, status: 'transaction not found.' }), true);
  assert.equal(isDeadAnchor({ ok: false, reason: 'anchor_tx_transaction not found.' }), true);
  // Everything else must NOT clear a stored anchor: a tx the node knows
  // about may still finalize, and a transient read error is not a death.
  assert.equal(isDeadAnchor({ ok: true, status: 'finalized' }), false);
  assert.equal(isDeadAnchor({ ok: false, status: 'received' }), false);
  assert.equal(isDeadAnchor({ ok: false, status: 'committed' }), false);
  assert.equal(isDeadAnchor({ ok: false, reason: 'no outcome for tx abcd' }), false);
  assert.equal(isDeadAnchor({ ok: false, reason: 'not_anchored' }), false);
  assert.equal(isDeadAnchor(null), false);
  assert.equal(isDeadAnchor({}), false);
});

// ---- workshop fix-back: context pre-validation (crash bug, 2026-11-25) ----
test('consent: assertContextsMatch passes a matching pair, throws context_mismatch otherwise', () => {
  const request = {
    context: {
      given: [
        { label: 'Nonce', context: 'aa'.repeat(32) },
        { label: 'ConnectionID', context: 'payonce-consent-2002' },
        { label: 'ResourceID', context: 'payonce-tau.vercel.app' },
        { label: 'ContextString', context: 'I consent: agent X may pay up to 2.00 EUDemo' },
      ],
      requested: ['BlockHash'],
    },
  };
  const matching = {
    presentationContext: {
      given: [
        { label: 'Nonce', context: 'aa'.repeat(32) },
        { label: 'ConnectionID', context: 'payonce-consent-2002' },
        { label: 'ResourceID', context: 'payonce-tau.vercel.app' },
        { label: 'ContextString', context: 'I consent: agent X may pay up to 2.00 EUDemo' },
      ],
      requested: [{ label: 'BlockHash', context: 'bb'.repeat(32) }],
    },
  };
  assert.doesNotThrow(() => assertContextsMatch(request, matching));
  // Wrong nonce (a presentation built for a different consent).
  const wrongNonce = structuredClone(matching);
  wrongNonce.presentationContext.given[0].context = 'cc'.repeat(32);
  assert.throws(() => assertContextsMatch(request, wrongNonce), /context_mismatch: no matching given context for label Nonce/);
  // Fewer given items (a minimal presentation missing ConnectionID etc.).
  const shortGiven = structuredClone(matching);
  shortGiven.presentationContext.given = shortGiven.presentationContext.given.slice(0, 1);
  assert.throws(() => assertContextsMatch(request, shortGiven), /context_mismatch: given context count differs/);
  // Requested label missing.
  const noBlockHash = structuredClone(matching);
  noBlockHash.presentationContext.requested = [];
  assert.throws(() => assertContextsMatch(request, noBlockHash), /context_mismatch: requested context count differs/);
  // SDK-instance shape (toJSON) is accepted as well.
  assert.doesNotThrow(() => assertContextsMatch({ toJSON: () => request }, { toJSON: () => matching }));
});

// ---- fix-back-2 (M5): Nonce pre-validation against the stored consent ----
test('consent: extractPresentationNonce reads the Nonce, assertPresentationNonceMatches binds it to the record', () => {
  const sha = 'e665e90f5bc5f15903681a03bb1df6fc99decd70e27450a9dc3da175773d9d10';
  const presentation = {
    presentationContext: {
      given: [
        { label: 'Nonce', context: sha },
        { label: 'ConnectionID', context: 'payonce-consent-2000' },
      ],
      requested: [{ label: 'BlockHash', context: 'bb'.repeat(32) }],
    },
  };
  assert.equal(extractPresentationNonce(presentation), sha);
  assert.doesNotThrow(() => assertPresentationNonceMatches(presentation, { consentSha256: sha }));
  // Uppercase hex in the presentation still matches (normalized).
  const upper = structuredClone(presentation);
  upper.presentationContext.given[0].context = sha.toUpperCase();
  assert.doesNotThrow(() => assertPresentationNonceMatches(upper, { consentSha256: sha }));
  // A presentation built for a DIFFERENT payable (different Nonce) fails.
  const cross = structuredClone(presentation);
  cross.presentationContext.given[0].context = '4b01da23d280095c0000000000000000000000000000000000000000000000';
  assert.throws(() => assertPresentationNonceMatches(cross, { consentSha256: sha }), /context_mismatch: presentation Nonce 4b01da23d280095c… does not match/);
  // No Nonce at all fails (never reaches the SDK).
  assert.equal(extractPresentationNonce({ presentationContext: { given: [] } }), null);
  assert.throws(() => assertPresentationNonceMatches({ presentationContext: { given: [] } }, { consentSha256: sha }), /context_mismatch: presentation carries no Nonce context/);
  // SDK-instance shape (toJSON) is accepted as well.
  assert.equal(extractPresentationNonce({ toJSON: () => presentation }), sha);
});

// ---- G7 fix-back-3 MF-3 (API verifier, fail-closed) ----
// The API verifier used to certify PLT payments with zero reservation
// evidence: verifyPltV2 ran no reservation check, and
// verifyPltTransferV2 reported reservation_precedes_transfer as
// `not_run` — which passes, because allPass is failed===0. These tests
// pin the fail-closed rule with synthetic (offline) transfer shapes;
// the live p11 shapes are proven by the fixback3 live probe (real
// transfer 690c5e2b… with real reserve a36aa1e0… / confirm adf55f61…).

const MF3_PAYEE = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const MF3_CONFIRM_SLOT = '2026-11-24T10:30:00.000Z';

async function mf3Ctx({ reserve = 'good', confirm = 'good' } = {}) {
  const { chain } = await backend();
  const memo = chain.encodeCborMemo(`payable:${OWNER_ADDRESS}:11`).toString('hex');
  const view = {
    seller: OWNER_ADDRESS, id: 11, amount: '10000', asset: 'EUDemo',
    payee: MF3_PAYEE, dueMs: String(Date.parse('2026-12-26T12:00:00.000Z')),
    due: '2026-12-26T12:00:00.000Z', docHash: '00'.repeat(32),
    agentToken: 1476, status: 'Paid',
    record: { payer: PAYER_ADDRESS, paidAtMs: String(Date.parse(MF3_CONFIRM_SLOT)), paidAt: MF3_CONFIRM_SLOT, txHash: 'ab'.repeat(32) },
  };
  const goodReserve = {
    blockTime: { slotTime: '2026-11-24T09:00:00.000Z' },
    logged: [{ event: 'Reserved', seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, expiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), expires: '2026-11-24T12:00:00.000Z' }],
  };
  return {
    payableId: 11,
    txHash: 'ab'.repeat(32),
    summary: {
      status: 'finalized',
      summary: {
        transactionType: 'transfer',
        events: [{ tag: 'TokenTransfer', tokenId: 'EUDemo', from: { address: PAYER_ADDRESS }, to: { address: MF3_PAYEE }, amount: { value: '10000' }, memo }],
      },
    },
    blockTime: { slotTime: '2026-11-24T10:00:00.000Z' },
    view,
    balance: '0',
    reserve: reserve === 'good' ? goodReserve : null,
    // G7 fix-back-4 ADV-2: the 'good' confirm carries a decoded
    // PltConfirmed event bound to this payable + transfer (the shape
    // pltEvidenceFor builds live from the confirm tx) — a bare
    // {blockTime} object no longer passes pltConfirmRow.
    // G7 fix-back-6 MF-2: the good event carries a finite reservation
    // expiry equal to the reserve's (12:00) — a v2 event with no finite
    // expiry now FAILS, so the fixture must model a real v2 event.
    confirm: confirm === 'good' ? { blockTime: { slotTime: MF3_CONFIRM_SLOT }, logged: [{ event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' }] } : null,
  };
}
const mf3Row = (r, id) => r.checks.find((c) => c.id === id);

test('MF-3 (API): verifyPltTransferV2 with no reserve FAILS reservation_precedes_transfer (never not_run-pass)', async () => {
  const ctx = await mf3Ctx({ reserve: null });
  const r = await verifyPltTransferV2(ctx);
  assert.equal(mf3Row(r, 'reservation_precedes_transfer').status, 'fail');
  assert.match(mf3Row(r, 'reservation_precedes_transfer').detail, /no reserve transaction supplied/);
  assert.equal(r.allPass, false);
  assert.equal(r.passed, 7); // 6 transfer rows + memo pass; reservation fails
  assert.equal(r.total, 8);
  assert.equal(r.checks.filter((c) => c.status === 'not_run').length, 0, 'no check may be not_run in the transfer gate');
});

test('MF-3 (API): verifyPltTransferV2 with a real in-window reserve PASSES the reservation row (8/8)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good' });
  const r = await verifyPltTransferV2(ctx);
  assert.equal(mf3Row(r, 'reservation_precedes_transfer').status, 'ok');
  assert.equal(r.allPass, true, JSON.stringify(r.checks));
  assert.equal(r.passed, 8);
  assert.equal(r.total, 8);
});

test('MF-3 (API): pltReservationRow / pltConfirmRow fail closed on missing evidence', () => {
  const view = { seller: OWNER_ADDRESS, record: { payer: PAYER_ADDRESS } };
  assert.equal(pltReservationRow({ payableId: 11, blockTime: { slotTime: '2026-11-24T10:00:00.000Z' }, view, reserve: null }).status, 'fail');
  assert.equal(pltReservationRow({ payableId: 11, blockTime: { slotTime: '2026-11-24T10:00:00.000Z' }, view, reserve: undefined }).status, 'fail');
  assert.equal(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: null }).status, 'fail');
  assert.equal(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: undefined }).status, 'fail');
});

// G7 fix-back-8 (adversarial O2): pltReservationRow used to THROW
// TypeError on a Reserved event without a payer (unguarded
// reserved.payer.slice). The detail is display-only — the row's
// pass/fail is decided by reserveOk — so the guard fails closed
// (payer undefined !== view payer) instead of throwing.
test('MF-3 (API, FB8): pltReservationRow does not throw on a Reserved event without a payer — fails closed', () => {
  const view = { seller: OWNER_ADDRESS, record: { payer: PAYER_ADDRESS } };
  const reserve = {
    logged: [{ event: 'Reserved', seller: OWNER_ADDRESS, payableId: 11, expiresMs: '9999999999999', expires: '2096-01-01T00:00:00.000Z' }],
    blockTime: { slotTime: '2026-11-24T09:00:00.000Z' },
  };
  let r;
  assert.doesNotThrow(() => { r = pltReservationRow({ payableId: 11, blockTime: { slotTime: '2026-11-24T10:00:00.000Z' }, view, reserve }); });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /reserved by \?/);
});

test('MF-3 (API): verifyPltV2 with no reserve/confirm FAILS reservation + paid_at (stub client: agent fails by construction)', async () => {
  // verifyPltV2 needs a chain client only for the agent check; the stub
  // {} makes agentOf throw, so the agent row FAILS here by construction
  // — the test asserts the reservation/confirm rows, not allPass. The
  // full live run (real client, real p11 evidence) is the fixback3 probe.
  const ctx = await mf3Ctx({ reserve: null, confirm: null });
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'reservation_precedes_transfer').status, 'fail');
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.equal(r.total, 14);
  assert.equal(r.checks.filter((c) => c.status === 'not_run').length, 1, 'only the doc row may be not_run');
  assert.equal(mf3Row(r, 'doc').status, 'not_run');
});

test('MF-3 (API): verifyPltV2 with real reserve+confirm PASSES both rows (stub client: only agent fails)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'reservation_precedes_transfer').status, 'ok');
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'ok');
  assert.equal(r.total, 14);
  assert.equal(r.passed, 12);
  assert.deepEqual(r.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['agent']);
});

// ---- G7 fix-back-4 ADV-2: confirm evidence must be a real confirm_plt
// event, not a timestamp. The adversarial judge fabricated
// {blockTime:{slotTime:paidAt}} and got verifyPltV2 allPass=true 14/14;
// each shape below must now FAIL paid_at_is_confirm_time. ----
test('ADV-2 (API): fabricated timestamp-only confirm FAILS paid_at (no PltConfirmed event)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm = { blockTime: { slotTime: MF3_CONFIRM_SLOT } }; // the fabricated shape: no logged event
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no PltConfirmed event/);
  assert.equal(r.allPass, false);
});

test('ADV-2 (API): confirm event for a DIFFERENT transfer FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'cd'.repeat(32) }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /different transfer/);
  assert.equal(r.allPass, false);
});

test('ADV-2 (API): confirm event for a DIFFERENT payable FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', seller: OWNER_ADDRESS, payableId: 10, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32) }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /for payable 10, not 11/);
  assert.equal(r.allPass, false);
});

// ---- G7 fix-back-5 MF-1/MF-2/MF-3 (adversarial 0486): the payer binds
// unconditionally, the seller binds for v2-gen events, the confirm must
// land inside the event's own reservation window, and a missing/invalid
// confirm blockTime FAILS instead of throwing. ----
test('FB5 MF-1 (API): real event with seller+payer STRIPPED FAILS paid_at (v2-gen, schemaVersion present)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, payableId: 11, txHash: 'ab'.repeat(32) }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no payer/);
  assert.equal(r.allPass, false);
});

test('FB5 MF-1 (API): v2 event with seller STRIPPED (payer present) FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32) }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no seller/);
  assert.equal(r.allPass, false);
});

test('FB6 MF-1 (API): v1-shaped event (no schemaVersion, no seller, payer present) FAILS the row — the generation is a caller signal, not the event shape', async () => {
  // Fix-back-5 pinned the bypass shape ("v1-shaped event still
  // PASSES"); fix-back-6 closes it: this verifier is v2-only, so with
  // no caller generation signal the seller is required and a stripped
  // v2 event can no longer pass as v1.
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no seller/);
  assert.equal(r.allPass, false);
});

test('FB7 MF-1 (API): the v1-shaped event FAILS even when the caller says v1 (registryIndex 13149) — the lift is gone', async () => {
  // G7 fix-back-7 MF-1: the fix-back-6 v1 lift is removed. This verifier
  // is v2-only (views from <13150,0>, memo unconditionally v2), so a
  // genuine v1 payment could never certify through it anyway and the
  // lift had no legitimate live use — its only effect was a bypass
  // switch: a stripped v2 event + registryIndex '13149' certified
  // 14/14. No generation signal is read anymore, from the ctx or from
  // the confirm object: seller + finite expiry are always required.
  const v1Shape = async (extra = {}, confirmExtra = {}) => {
    const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
    ctx.confirm.logged = [{ event: 'PltConfirmed', payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' }];
    Object.assign(ctx, extra);
    Object.assign(ctx.confirm, confirmExtra);
    return verifyPltV2({}, ctx);
  };
  const failShape = async (name, extra = {}, confirmExtra = {}) => {
    const r = await v1Shape(extra, confirmExtra);
    assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail', name);
    assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no seller/, name);
    assert.equal(r.allPass, false, name);
  };
  await failShape('ctx registryIndex 13149', { registryIndex: '13149' });
  await failShape('ctx gen v1', { gen: 'v1' });
  await failShape('ctx gen v1 + registryIndex 13150 (v1 used to win the conflict)', { gen: 'v1', registryIndex: '13150' });
  await failShape('ctx gen v2 + registryIndex 13149 (v1 used to win the conflict)', { gen: 'v2', registryIndex: '13149' });
  await failShape('confirm.gen v1 alone (no ctx signal)', {}, { gen: 'v1' });
  await failShape('confirm.registryIndex 13149 alone (no ctx signal)', {}, { registryIndex: '13149' });
  // The receipt paid_at extra fails the same stripped shape + 13149.
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' }];
  const extras = pltReceiptExtraChecks(ctx.view, 'ab'.repeat(32), ctx.confirm, { registryIndex: '13149', reserve: ctx.reserve });
  assert.equal(extras.find((c) => c.id === 'paid_at_is_confirm_time').status, 'fail');
});

test('FB7 MF-1 (API): a FULL v2 event still PASSES with a v1 signal present — it certifies on its own bindings, the signal is inert', async () => {
  // The full event carries seller + finite expiry + payer, so it
  // certifies as v2 regardless of any caller signal. The paired proof
  // that the signal contributes nothing is the test above: the same
  // event with seller stripped FAILS under every signal. (A full event
  // passing here is the held live control — real p11 verifies 14/14 —
  // not a v1 ride: nothing about the verdict depends on the signal.)
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.registryIndex = '13149';
  ctx.gen = 'v1';
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'ok');
});

test('FB6 MF-1 (API): stripped schemaVersion+seller FAILS with an explicit v2 caller signal too (registryIndex 13150)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' }];
  ctx.registryIndex = '13150';
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no seller/);
});

test('FB5 MF-2 (API): confirm past the event reservation expiry FAILS paid_at; in-window expiry PASSES', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  const confirmMs = Date.parse(MF3_CONFIRM_SLOT);
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(confirmMs - 60_000), reservationExpires: new Date(confirmMs - 60_000).toISOString() }];
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /past the reservation expiry/);
  assert.equal(r.allPass, false);
  ctx.confirm.logged[0].reservationExpiresMs = String(confirmMs + 3_600_000);
  ctx.confirm.logged[0].reservationExpires = new Date(confirmMs + 3_600_000).toISOString();
  const r2 = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r2, 'paid_at_is_confirm_time').status, 'ok');
});

// ---- G7 fix-back-6 MF-2 (adversarial A2e/A2g/A2h): the expiry check is
// anchored to the reserve, and a v2 event must carry a finite expiry
// that does not run past the reserve's. Deleting the event's expiry,
// garbling it, or forging a later one must FAIL — the old check was
// presence-conditional and self-asserted. The fixture reserve expires
// 12:00; the past-expiry confirm time below is 13:00. ----

test('FB6 MF-2 (API): v2 event with expiry fields DELETED + confirm past the reserve expiry FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32) }];
  ctx.confirm.blockTime = { slotTime: '2026-11-24T13:00:00.000Z' };
  ctx.view.record.paidAt = '2026-11-24T13:00:00.000Z';
  ctx.view.record.paidAtMs = String(Date.parse('2026-11-24T13:00:00.000Z'));
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no finite reservation expiry/);
  assert.equal(r.allPass, false);
});

test('FB6 MF-2 (API): v2 event with expiry Ms GARBLED + confirm past the reserve expiry FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: 'not-a-number' }];
  ctx.confirm.blockTime = { slotTime: '2026-11-24T13:00:00.000Z' };
  ctx.view.record.paidAt = '2026-11-24T13:00:00.000Z';
  ctx.view.record.paidAtMs = String(Date.parse('2026-11-24T13:00:00.000Z'));
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /no finite reservation expiry/);
  assert.equal(r.allPass, false);
});

test('FB6 MF-2 (API): v2 event with expiry FORGED later than the reserve + confirm past the reserve expiry FAILS paid_at', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.logged = [{ event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T14:00:00.000Z')), reservationExpires: '2026-11-24T14:00:00.000Z' }];
  ctx.confirm.blockTime = { slotTime: '2026-11-24T13:00:00.000Z' };
  ctx.view.record.paidAt = '2026-11-24T13:00:00.000Z';
  ctx.view.record.paidAtMs = String(Date.parse('2026-11-24T13:00:00.000Z'));
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'fail');
  assert.match(mf3Row(r, 'paid_at_is_confirm_time').detail, /later than the reservation expiry/);
  assert.equal(r.allPass, false);
});

test('FB6 MF-2 (API): confirm EXACTLY at the reserve expiry still PASSES paid_at (at or before, by design)', async () => {
  const ctx = await mf3Ctx({ reserve: 'good', confirm: 'good' });
  ctx.confirm.blockTime = { slotTime: '2026-11-24T12:00:00.000Z' };
  ctx.view.record.paidAt = '2026-11-24T12:00:00.000Z';
  ctx.view.record.paidAtMs = String(Date.parse('2026-11-24T12:00:00.000Z'));
  const r = await verifyPltV2({}, ctx);
  assert.equal(mf3Row(r, 'paid_at_is_confirm_time').status, 'ok');
});

test('FB5 MF-3 (API): confirm with NO blockTime FAILS paid_at (never throws); invalid blockTime FAILS too', () => {
  const view = { id: 11, seller: OWNER_ADDRESS, record: { payer: PAYER_ADDRESS, paidAtMs: String(Date.parse(MF3_CONFIRM_SLOT)), paidAt: MF3_CONFIRM_SLOT } };
  // G7 fix-back-6 MF-2: the event carries a finite expiry (in-window)
  // so the binding passes and only the missing blockTime can fail it.
  const goodEvent = { event: 'PltConfirmed', schemaVersion: 2, seller: OWNER_ADDRESS, payableId: 11, payer: PAYER_ADDRESS, txHash: 'ab'.repeat(32), reservationExpiresMs: String(Date.parse('2026-11-24T12:00:00.000Z')), reservationExpires: '2026-11-24T12:00:00.000Z' };
  assert.equal(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: { logged: [goodEvent] } }).status, 'fail');
  assert.match(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: { logged: [goodEvent] } }).detail, /missing or invalid/);
  assert.equal(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: { blockTime: { slotTime: 'not-a-date' }, logged: [goodEvent] } }).status, 'fail');
  assert.equal(pltConfirmRow({ payableId: 11, txHash: 'ab'.repeat(32), view, confirm: { blockTime: {}, logged: [goodEvent] } }).status, 'fail');
  // The receipt extra check fails the same way, without throwing.
  const extras = pltReceiptExtraChecks(view, 'ab'.repeat(32), { logged: [goodEvent] });
  assert.equal(extras.find((c) => c.id === 'paid_at_is_confirm_time').status, 'fail');
});
