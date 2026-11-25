// PayOnce backend — hosted x402 facilitator tests (UNIT — no network, no keys).
// The hosted client is exercised against a stub fetch; the API key used here
// is a FAKE value that must never be a real key. Nothing here touches the
// seed, the chain, or the real facilitator (see hosted-facilitator-live.test.mjs
// for the live probe, which skips without X402_FACILITATOR_API_KEY in env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCborMemo } from '../src/chain.mjs';
import {
  Cbor, CborMemo, CborAccountAddress, TokenAmount,
} from '@concordium/web-sdk';
import {
  createHostedFacilitator, requirementsForHostedPayable, HostedFacilitatorError,
  HOSTED_TESTNET_CAIP2,
} from '../src/facilitator/hosted.mjs';
import { verifyPayableHostedFirst, settlePayableHostedFirst, confirmSettleTxOnChain, matchSettleTxContents, FALLBACK_ELIGIBLE_CODES, FAIL_CLOSED_CODES } from '../src/facilitator/hosted-payonce.mjs';
import { checkPayableBinding, extractCborTexts } from '../src/facilitator/binding.mjs';

const FAKE_KEY = 'test-key-fake-000-not-a-real-key';
const HOSTED_ADDR = '3U1m4EhpixbWB3d4qqNZkTzapzcWFjVobwkV1kEyLjiQFGGrS1';
const PAYEE = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const PAYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';

const EUD_VIEW = { id: 3, status: 'Unpaid', asset: 'EUDemo', amount: '10000', payee: PAYEE };
const CCD_VIEW = { id: 8, status: 'Unpaid', asset: 'CCD', amount: '500000', payee: PAYEE };

function reqFor(view, feePayer = HOSTED_ADDR) {
  return { scheme: 'exact', network: HOSTED_TESTNET_CAIP2, amount: String(view.amount), asset: view.asset, payTo: view.payee, maxTimeoutSeconds: 300, extra: { feePayer } };
}
function pltPayloadWithMemo(memoText) {
  // REAL tokenUpdate operations CBOR, exactly as the SDK builds it: the memo
  // is a tag-24-wrapped byte string holding the CBOR text encoding of the
  // memo. (The old helper faked the ops as `00<memoHex>00`, which is not
  // CBOR at all — the real memo-canonical check CBOR-walks the operations,
  // so the fixture must be real CBOR too.)
  const ops = Cbor.encode([{
    transfer: {
      amount: TokenAmount.create(10000n, 6),
      recipient: CborAccountAddress.fromBase58(PAYEE),
      memo: CborMemo.fromString(memoText),
    },
  }]);
  const opsHex = Buffer.from(Cbor.toBuffer(ops)).toString('hex');
  return { x402Version: 2, accepted: reqFor(EUD_VIEW), payload: { signedTransaction: { version: 1, header: {}, payload: { operations: opsHex }, signatures: {} } } };
}
function ccdPayload() {
  return { x402Version: 2, accepted: reqFor(CCD_VIEW), payload: { signedTransaction: { version: 1, header: {}, payload: {}, signatures: {} } } };
}
function loadPayable(view) {
  return async (id) => {
    if (id !== view.id) throw new Error(`payable ${id} not found`);
    return view;
  };
}

/** Stub fetch: records calls; answers from a per-test handler. */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls);
  };
  return { fetchImpl, calls };
}
function jsonResponse(status, obj) {
  return { status, text: async () => JSON.stringify(obj) };
}

test('hosted client: verify sends X-API-Key (never Bearer) and the x402 body', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const out = await hosted.verify({ x402Version: 2 }, { scheme: 'exact' });
  assert.equal(out.isValid, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/verify$/);
  assert.equal(calls[0].opts.headers['X-API-Key'], FAKE_KEY);
  assert.equal(calls[0].opts.headers.Authorization, undefined);
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(Object.keys(body).sort(), ['paymentPayload', 'paymentRequirements']);
});

test('hosted client: no apiKey throws (fail closed, no default key)', () => {
  assert.throws(() => createHostedFacilitator({}), /X402_FACILITATOR_API_KEY is required/);
  assert.throws(() => createHostedFacilitator({ apiKey: '' }), /X402_FACILITATOR_API_KEY is required/);
});

test('hosted client: 401 -> hosted_auth_failed, key never in the error', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(401, { success: false, error: 'Unauthorized' }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => {
    assert.ok(e instanceof HostedFacilitatorError);
    assert.equal(e.code, 'hosted_auth_failed');
    assert.ok(!e.message.includes(FAKE_KEY), 'key must never appear in an error message');
    return true;
  });
});

test('hosted client: 400 ZodError -> hosted_invalid_payload with issue count', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(400, { success: false, error: 'Invalid request body', details: { issues: [{ path: ['paymentPayload'] }, { path: ['paymentRequirements'] }], name: 'ZodError' } }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => {
    assert.equal(e.code, 'hosted_invalid_payload');
    assert.match(e.message, /2 validation issue/);
    assert.ok(!e.message.includes(FAKE_KEY));
    return true;
  });
});

test('hosted client: 500 -> hosted_unavailable; network throw -> hosted_unreachable (no key in message)', async () => {
  const h500 = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => jsonResponse(500, {})).fetchImpl });
  await assert.rejects(() => h500.verify({}, {}), (e) => e.code === 'hosted_unavailable');
  const hNet = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(() => hNet.verify({}, {}), (e) => {
    assert.equal(e.code, 'hosted_unreachable');
    assert.ok(!e.message.includes(FAKE_KEY) && !e.message.includes('boom'));
    return true;
  });
});

test('hosted client: 200 verdict passes through unchanged (invalid is an answer, not an error)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: false, invalidReason: 'invalid_sender_signature', payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const out = await hosted.verify({}, {});
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'invalid_sender_signature');
  assert.equal(out.payer, PAYER);
});

test('hosted client: feePayer() reads the testnet kind from /supported', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, {
    kinds: [{ x402Version: 2, scheme: 'exact', network: HOSTED_TESTNET_CAIP2, extra: { feePayer: HOSTED_ADDR } }],
    extensions: [], signers: { 'ccd:*': [HOSTED_ADDR] },
  }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(await hosted.feePayer(), HOSTED_ADDR);
  assert.match(calls[0].url, /\/supported$/);
});

test('requirementsForHostedPayable: hosted feePayer shape; feePayer required', () => {
  const req = requirementsForHostedPayable(EUD_VIEW, { feePayer: HOSTED_ADDR });
  assert.equal(req.scheme, 'exact');
  assert.equal(req.network, HOSTED_TESTNET_CAIP2);
  assert.equal(req.amount, '10000');
  assert.equal(req.asset, 'EUDemo');
  assert.equal(req.payTo, PAYEE);
  assert.equal(req.extra.feePayer, HOSTED_ADDR);
  assert.equal(req.extra.payableId, 3);
  assert.throws(() => requirementsForHostedPayable(EUD_VIEW, {}), /feePayer.*is required/);
});

function fakeSelfHosted(verifyResult) {
  let calls = 0;
  return {
    calls: () => calls,
    scheme: { verify: async () => { calls += 1; return verifyResult; } },
    network: HOSTED_TESTNET_CAIP2,
  };
}

test('hosted-first verify: hosted VALID + binding ok -> hosted, self-hosted never called', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, true);
  assert.equal(out.facilitator, 'hosted');
  assert.equal(out.payer, PAYER);
  assert.equal(selfHosted.calls(), 0);
  assert.ok(out.payonce.checks.every((c) => c.ok));
});

test('hosted-first verify: hosted REJECTION is final — no fallback', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: false, invalidReason: 'invalid_sender_signature', payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'invalid_sender_signature');
  assert.equal(out.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0, 'a hosted rejection must never trigger the self-hosted fallback');
});

test('hosted-first verify: hosted UNREACHABLE -> labelled self-hosted fallback', async () => {
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: async () => { throw new Error('down'); } });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, true);
  assert.equal(out.facilitator, 'self-hosted-fallback');
  assert.equal(out.fallbackReason, 'hosted_unreachable');
  assert.equal(selfHosted.calls(), 1);
});

test('hosted-first verify: hosted 401 (revoked key) NEVER falls back', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(401, { success: false, error: 'Unauthorized' }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'hosted_auth_failed');
  assert.equal(out.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0, 'an auth failure must surface, not be papered over by the owner sponsoring');
});

test('hosted-first verify: hosted VALID but binding fails (wrong amount) -> hosted, no fallback', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW, HOSTED_ADDR),
    payableId: 3, expectedStatus: 'Unpaid',
  });
  // Tamper the requirements amount after building the payload: binding must refuse.
  const out2 = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'),
    requirements: { ...reqFor(EUD_VIEW), amount: '10001' }, payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, true); // control: correct amount passes
  assert.equal(out2.isValid, false);
  assert.equal(out2.invalidReason, 'amount_mismatch');
  assert.equal(out2.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0);
});

test('hosted-first verify: hosted VALID but wrong memo -> memo_missing (hosted never checks the memo)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted: fakeSelfHosted({ isValid: true, payer: PAYER }), loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:4'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'memo_missing');
  assert.equal(out.facilitator, 'hosted');
});

test('hosted-first settle: hosted success passes through; transport failure fails WITHOUT fallback', async () => {
  // settle flow: first verify (stubbed valid), then settle (stubbed success). One stub serves both calls.
  const fetchImpl = async (url) => {
    if (url.endsWith('/verify')) return jsonResponse(200, { isValid: true, payer: PAYER });
    if (url.endsWith('/settle')) return jsonResponse(200, { success: true, network: HOSTED_TESTNET_CAIP2, transaction: 'aa'.repeat(32), payer: PAYER });
    throw new Error(`unexpected ${url}`);
  };
  const hostedOk = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const confirmOk = async () => ({ confirmed: true, status: 'finalized', blockHash: '00'.repeat(32) });
  const outOk = await settlePayableHostedFirst({
    hosted: hostedOk, loadPayable: loadPayable(CCD_VIEW),
    payload: ccdPayload(), requirements: reqFor(CCD_VIEW), payableId: 8, expectedStatus: 'Unpaid',
    confirmTx: confirmOk,
  });
  assert.equal(outOk.success, true);
  assert.equal(outOk.facilitator, 'hosted');
  assert.equal(outOk.transaction, 'aa'.repeat(32));
  assert.deepEqual(outOk.settleConfirmation, { status: 'finalized', blockHash: '00'.repeat(32) });

  const fetchDown = async (url) => {
    if (url.endsWith('/verify')) return jsonResponse(200, { isValid: true, payer: PAYER });
    throw new Error('down');
  };
  const hostedDown = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: fetchDown });
  const outDown = await settlePayableHostedFirst({
    hosted: hostedDown, loadPayable: loadPayable(CCD_VIEW),
    payload: ccdPayload(), requirements: reqFor(CCD_VIEW), payableId: 8, expectedStatus: 'Unpaid',
  });
  assert.equal(outDown.success, false);
  assert.equal(outDown.errorReason, 'hosted_unreachable');
  assert.equal(outDown.transaction, '');
  assert.equal(outDown.facilitator, 'hosted');
});

test('binding: payable not found / wrong status refuse on the PayOnce layer', async () => {
  const missing = await checkPayableBinding({
    verifyResult: { isValid: true, payer: PAYER }, payload: ccdPayload(), requirements: reqFor(CCD_VIEW),
    payableId: 999, expectedStatus: null, loadPayable: loadPayable(CCD_VIEW),
  });
  assert.equal(missing.isValid, false);
  assert.equal(missing.invalidReason, 'payable_not_found');
  const wrongStatus = await checkPayableBinding({
    verifyResult: { isValid: true, payer: PAYER }, payload: ccdPayload(), requirements: reqFor(CCD_VIEW),
    payableId: 8, expectedStatus: 'Paid', loadPayable: loadPayable(CCD_VIEW),
  });
  assert.equal(wrongStatus.isValid, false);
  assert.equal(wrongStatus.invalidReason, 'payable_wrong_status');
});

// ---- FIX-BACK tests (2026-11-25): MF-X402-A1, A2, F4-404, A5, H4/F1 ----

const EUD_VIEW_9 = { id: 9, status: 'Unpaid', asset: 'EUDemo', amount: '10000', payee: PAYEE };
const EUD_VIEW_30 = { id: 30, status: 'Unpaid', asset: 'EUDemo', amount: '10000', payee: PAYEE };

test('FIXBACK A1: hosted 403 -> hosted_auth_failed, NEVER falls back (auth-adjacent like 401)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(403, { error: 'Forbidden' }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => {
    assert.equal(e.code, 'hosted_auth_failed');
    assert.ok(!e.message.includes(FAKE_KEY));
    return true;
  });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'hosted_auth_failed');
  assert.equal(out.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0, 'a 403 must surface, not silently switch the sponsor to the owner');
});

test('FIXBACK A2: hosted 429 -> hosted_rate_limited, NEVER falls back (deliberate refusal, not transport)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(429, { error: 'Too Many Requests' }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => e.code === 'hosted_rate_limited');
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'hosted_rate_limited');
  assert.equal(out.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0, 'a 429 must not silently abandon hosted-first under load');
});

test('FIXBACK F4: hosted 404 -> hosted_not_found, NEVER falls back (misconfigured URL, not transport)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(404, { error: 'not_found' }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => e.code === 'hosted_not_found');
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'hosted_not_found');
  assert.equal(out.facilitator, 'hosted');
  assert.equal(selfHosted.calls(), 0, 'a 404 must not be masked as a transport blip');
});

test('FIXBACK H4/F1: memo-canonical is real — a longer memo containing the canonical bytes FAILS', async () => {
  // 'ipayable:9' contains the 'payable:9' CBOR bytes as a substring, so the
  // old vacuous check passed it. The real check decodes the memo bytes
  // actually found in the operations: the memo is 'ipayable:9', not 'payable:9'.
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted: fakeSelfHosted({ isValid: true, payer: PAYER }), loadPayable: loadPayable(EUD_VIEW_9),
    payload: pltPayloadWithMemo('ipayable:9'), requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'memo_not_canonical');
  assert.equal(out.facilitator, 'hosted');
  // Control: the exact memo still passes with all 7 binding checks true.
  const outOk = await verifyPayableHostedFirst({
    hosted, selfHosted: fakeSelfHosted({ isValid: true, payer: PAYER }), loadPayable: loadPayable(EUD_VIEW_9),
    payload: pltPayloadWithMemo('payable:9'), requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  assert.equal(outOk.isValid, true);
  assert.ok(outOk.payonce.checks.every((c) => c.ok));
});

test('FIXBACK H4/F1: cross-payable + prefix attacks fail (payable:3 as 9; payable:30 as 3; payable:3 as 30)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  // Cross-payable: memo payable:3 asked as payable 9 -> memo_missing.
  const cross = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_9),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  assert.equal(cross.isValid, false);
  assert.equal(cross.invalidReason, 'memo_missing');
  // Prefix attack 1: memo payable:30 asked as payable 3 -> memo_missing.
  const prefix1 = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:30'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(prefix1.isValid, false);
  assert.equal(prefix1.invalidReason, 'memo_missing');
  // Prefix attack 2: memo payable:3 asked as payable 30 -> memo_missing.
  const prefix2 = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_30),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW_30), payableId: 30, expectedStatus: 'Unpaid',
  });
  assert.equal(prefix2.isValid, false);
  assert.equal(prefix2.invalidReason, 'memo_missing');
});

test('FIXBACK A5: hosted settle success with UNCONFIRMED tx -> success:false, hosted_settle_unconfirmed, never ledgered', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/verify')) return jsonResponse(200, { isValid: true, payer: PAYER });
    if (url.endsWith('/settle')) return jsonResponse(200, { success: true, network: HOSTED_TESTNET_CAIP2, transaction: 'ab'.repeat(32), payer: PAYER });
    throw new Error(`unexpected ${url}`);
  };
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  // The fake hosted claims a tx that never existed on chain: read-back refuses it.
  const out = await settlePayableHostedFirst({
    hosted, loadPayable: loadPayable(CCD_VIEW),
    payload: ccdPayload(), requirements: reqFor(CCD_VIEW), payableId: 8, expectedStatus: 'Unpaid',
    confirmTx: async () => ({ confirmed: false, reason: 'transaction abababababab… not found committed on chain after read-back' }),
  });
  assert.equal(out.success, false);
  assert.equal(out.errorReason, 'hosted_settle_unconfirmed');
  assert.equal(out.transaction, '');
  assert.equal(out.claimedTransaction, 'ab'.repeat(32));
  assert.equal(out.facilitator, 'hosted');
  // A read-back that throws is also unconfirmed, not successful.
  const outThrow = await settlePayableHostedFirst({
    hosted, loadPayable: loadPayable(CCD_VIEW),
    payload: ccdPayload(), requirements: reqFor(CCD_VIEW), payableId: 8, expectedStatus: 'Unpaid',
    confirmTx: async () => { throw new Error('grpc down'); },
  });
  assert.equal(outThrow.success, false);
  assert.equal(outThrow.errorReason, 'hosted_settle_unconfirmed');
  assert.equal(outThrow.transaction, '');
});

test('FIXBACK A5: confirmSettleTxOnChain rejects a malformed hash without any network call', async () => {
  const out = await confirmSettleTxOnChain('not-a-hash');
  assert.equal(out.confirmed, false);
  assert.match(out.reason, /not a 64-hex hash/);
  const outEmpty = await confirmSettleTxOnChain('');
  assert.equal(outEmpty.confirmed, false);
});

test('FIXBACK H4/F1: extractCborTexts finds the memo inside the tag-24 inner encoding', () => {
  // Operations hex built by pltPayloadWithMemo('payable:9'): the memo lives
  // as tag-24 bytes containing the CBOR text encoding.
  const payload = pltPayloadWithMemo('payable:9');
  const opsHex = payload.payload.signedTransaction.payload.operations;
  const texts = extractCborTexts(opsHex);
  assert.ok(texts, 'operations must parse as one CBOR value');
  assert.ok(texts.some((t) => t.text === 'payable:9' && t.rawHex === encodeCborMemo('payable:9').toString('hex')));
  const textsLong = extractCborTexts(pltPayloadWithMemo('ipayable:9').payload.signedTransaction.payload.operations);
  assert.ok(textsLong.some((t) => t.text === 'ipayable:9'));
  assert.ok(!textsLong.some((t) => t.text === 'payable:9' && t.rawHex === encodeCborMemo('payable:9').toString('hex')));
  assert.equal(extractCborTexts('zzzz'), null);
  assert.equal(extractCborTexts(''), null);
});

// ---- FIXBACK2 tests (2026-11-25): MF-X402-FB-A1 (unmapped 4xx), MF-X402-FB-A2
// (settle contents), OB-2 (whitespace key), OB-3 (tag-24-only memo) ----

test('FIXBACK2 A1: EVERY unmapped 4xx -> hosted_unexpected_status, NEVER falls back', async () => {
  // The fix-back-1 judge's M-V probes: 405/408/409/413/418/422 all fell back.
  for (const status of [405, 408, 409, 413, 418, 422]) {
    const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: 'refused' }));
    const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
    await assert.rejects(() => hosted.verify({}, {}), (e) => {
      assert.equal(e.code, 'hosted_unexpected_status', `HTTP ${status} must map to hosted_unexpected_status`);
      assert.ok(!e.message.includes(FAKE_KEY));
      return true;
    });
    const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
    const out = await verifyPayableHostedFirst({
      hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW),
      payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
    });
    assert.equal(out.isValid, false, `HTTP ${status} verify must fail closed`);
    assert.equal(out.invalidReason, 'hosted_unexpected_status');
    assert.equal(out.facilitator, 'hosted');
    assert.equal(selfHosted.calls(), 0, `HTTP ${status} must not silently switch the sponsor to the owner`);
  }
});

test('FIXBACK2 A1: a surfaced 3xx also fails closed (hosted_unexpected_status)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(301, {}));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  await assert.rejects(() => hosted.verify({}, {}), (e) => e.code === 'hosted_unexpected_status');
  // Control: 5xx still falls back labelled, 200-malformed still bad_response.
  const h500 = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => jsonResponse(503, {})).fetchImpl });
  await assert.rejects(() => h500.verify({}, {}), (e) => e.code === 'hosted_unavailable');
  const hBad = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => jsonResponse(200, { nope: true })).fetchImpl });
  await assert.rejects(() => hBad.verify({}, {}), (e) => e.code === 'hosted_bad_response');
});

test('FIXBACK2 OB-2: whitespace-only API key throws (no key, fail closed at construction)', () => {
  assert.throws(() => createHostedFacilitator({ apiKey: ' ' }), /X402_FACILITATOR_API_KEY is required/);
  assert.throws(() => createHostedFacilitator({ apiKey: '  \t ' }), /X402_FACILITATOR_API_KEY is required/);
});

// Real on-chain summaries (shapes verified live 2026-11-25 via gRPC):
// Rail-A settle 74a06a17… — CCD transfer, sender 4MvdM… (payer B), 500000 to payee2.
// Transfer9 441b470f… — EUDemo tokenUpdate, sender 4MvdM…, 10000 to payee2, memo 'ipayable:9'.
const RAIL_A_SUMMARY = {
  type: 'accountTransaction', sender: PAYER, transactionType: 'transfer',
  transfer: { tag: 'Transferred', amount: '500000', to: PAYEE },
};
const TRANSFER9_SUMMARY = {
  type: 'accountTransaction', sender: PAYER, transactionType: 'tokenUpdate',
  events: [{ tag: 'TokenTransfer', tokenId: 'EUDemo', from: { type: 'account', address: PAYER }, to: { type: 'account', address: PAYEE }, amount: { value: '10000', decimals: 6 }, memo: Buffer.from('ipayable:9', 'utf8').toString('hex') }],
};
function grpcStub(summary) {
  return {
    getBlockItemStatus: async () => ({
      status: 'finalized',
      outcome: { blockHash: '00'.repeat(32), summary },
    }),
  };
}
const RAIL_A_HASH = '74a06a175440a7a0031e67a0662d2e35d7404b8bf69105276b0966ff87dc6283';

test('FIXBACK2 A2: matchSettleTxContents — CCD match passes; wrong sender/amount/recipient/type fail', () => {
  const ccdExpected = { sender: PAYER, amount: '500000', recipient: PAYEE, asset: 'CCD', payableId: 8 };
  assert.equal(matchSettleTxContents(RAIL_A_SUMMARY, ccdExpected), null);
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, { ...ccdExpected, sender: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' }), /sender/);
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, { ...ccdExpected, amount: '10000' }), /amount/);
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, { ...ccdExpected, recipient: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' }), /recipient/);
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, { ...ccdExpected, asset: 'EUDemo', payableId: 3 }), /not a tokenUpdate/);
  assert.match(matchSettleTxContents(null, ccdExpected), /no tx summary/);
});

test('FIXBACK2 A2: matchSettleTxContents — PLT match passes only with the canonical payable memo', () => {
  const pltExpected = { sender: PAYER, amount: '10000', recipient: PAYEE, asset: 'EUDemo', payableId: 9 };
  // Transfer9's memo is 'ipayable:9', not 'payable:9' — it must NOT match payable 9.
  assert.match(matchSettleTxContents(TRANSFER9_SUMMARY, pltExpected), /memo/);
  const goodMemo = JSON.parse(JSON.stringify(TRANSFER9_SUMMARY));
  goodMemo.events[0].memo = Buffer.from('payable:9', 'utf8').toString('hex');
  assert.equal(matchSettleTxContents(goodMemo, pltExpected), null);
  assert.match(matchSettleTxContents(goodMemo, { ...pltExpected, amount: '10001' }), /no EUDemo transfer/);
  const noMemo = JSON.parse(JSON.stringify(goodMemo));
  delete noMemo.events[0].memo;
  assert.match(matchSettleTxContents(noMemo, pltExpected), /memo/);
});

test('FIXBACK2 A2: confirmSettleTxOnChain with the REAL unrelated Rail-A hash vs payable 3 (EUDemo) -> contentMismatch, never confirmed', async () => {
  const out = await confirmSettleTxOnChain(RAIL_A_HASH, {
    grpc: grpcStub(RAIL_A_SUMMARY),
    expected: { sender: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', amount: '10000', recipient: PAYEE, asset: 'EUDemo', payableId: 3 },
  });
  assert.equal(out.confirmed, false);
  assert.equal(out.contentMismatch, true);
  assert.match(out.reason, /contents do not match/);
  // The same hash against the payment it REALLY belongs to (CCD payable 8) confirms.
  const outOk = await confirmSettleTxOnChain(RAIL_A_HASH, {
    grpc: grpcStub(RAIL_A_SUMMARY),
    expected: { sender: PAYER, amount: '500000', recipient: PAYEE, asset: 'CCD', payableId: 8 },
  });
  assert.equal(outOk.confirmed, true);
  assert.equal(outOk.status, 'finalized');
  // Existence alone is no longer a confirmation: no expected payload -> unconfirmed.
  const outNoExp = await confirmSettleTxOnChain(RAIL_A_HASH, { grpc: grpcStub(RAIL_A_SUMMARY) });
  assert.equal(outNoExp.confirmed, false);
  assert.match(outNoExp.reason, /no expected settle contents/);
});

test('FIXBACK2 A2: settlePayableHostedFirst with the REAL unrelated Rail-A hash for payable 3 -> hosted_settle_content_mismatch, never success', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/verify')) return jsonResponse(200, { isValid: true, payer: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' });
    if (url.endsWith('/settle')) return jsonResponse(200, { success: true, network: HOSTED_TESTNET_CAIP2, transaction: RAIL_A_HASH, payer: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' });
    throw new Error(`unexpected ${url}`);
  };
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  // The stub gRPC returns the REAL Rail-A summary for the claimed hash.
  const out = await settlePayableHostedFirst({
    hosted, grpc: grpcStub(RAIL_A_SUMMARY), loadPayable: loadPayable(EUD_VIEW),
    payload: pltPayloadWithMemo('payable:3'), requirements: reqFor(EUD_VIEW), payableId: 3, expectedStatus: 'Unpaid',
  });
  assert.equal(out.success, false);
  assert.equal(out.errorReason, 'hosted_settle_content_mismatch');
  assert.equal(out.transaction, '');
  assert.equal(out.claimedTransaction, RAIL_A_HASH);
  assert.equal(out.facilitator, 'hosted');
});

test('FIXBACK2 OB-3: memo as a map KEY, or as a bare array element, no longer passes memo-canonical', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const memoHex = encodeCborMemo('payable:9').toString('hex');
  const bindOps = async (opsHex) => verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_9),
    payload: { x402Version: 2, accepted: reqFor(EUD_VIEW_9), payload: { signedTransaction: { version: 1, header: {}, payload: { operations: opsHex }, signatures: {} } } },
    requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  // W13 (adversarial): map {'payable:9': 1} — memo as a KEY only.
  const mapKey = await bindOps(`a1${memoHex}01`);
  assert.equal(mapKey.isValid, false);
  assert.equal(mapKey.invalidReason, 'memo_not_canonical');
  // W6 (adversarial): array [1, 'payable:9'] — memo as a bare 2nd element.
  const secondElem = await bindOps(`8201${memoHex}`);
  assert.equal(secondElem.isValid, false);
  assert.equal(secondElem.invalidReason, 'memo_not_canonical');
  // W5-style: byte-string bytes + a bare canonical text alongside — also not
  // a memo field (a genuine PLT memo is always tag-24-wrapped), so it fails.
  const bareAlongside = await bindOps(`824a${memoHex}${memoHex}`);
  assert.equal(bareAlongside.isValid, false);
  assert.equal(bareAlongside.invalidReason, 'memo_not_canonical');
  // Control: the tag-24-wrapped canonical memo (the real PLT shape) still passes.
  const tag24 = await bindOps(`d8184a${memoHex}`);
  assert.equal(tag24.isValid, true);
  // Walker-level: the tag-24 inner text is flagged viaTag24; bare texts are not.
  const found = extractCborTexts(`d8184a${memoHex}`);
  assert.ok(found.some((t) => t.text === 'payable:9' && t.viaTag24 === true));
  const foundBare = extractCborTexts(memoHex);
  assert.ok(foundBare.some((t) => t.text === 'payable:9' && t.viaTag24 === false));
});

// ---- FIXBACK3 tests (2026-11-25): MF-X402-FB2-A1 (/supported fail-closed
// taxonomy), MF-X402-FB2-A2a/A2b (partial expected), MF-X402-FB2-A2c
// (second transfer, non-blocking), MF-X402-FB2-B1 (tag-24 inner must be the
// memo text). Count: 6 new tests (A1 x1, A2a x1, A2b x1, A2c x1, B1 x2).
// (Correction of the fix-back-2 report's labels, F-X402-FB2-H1: the
// fix-back-2 A2 tests are x4, not x3 — CCD matrix, PLT matrix,
// confirmSettleTxOnChain, settlePayableHostedFirst — so fix-back-2 added 8
// tests: A1 x2, A2 x4, OB-2, OB-3. This round adds 6 more: 32 + 6 = 38.)

test('FIXBACK3 A1: the fallback taxonomy itself — only transport codes are fallback-eligible', () => {
  // The server /supported handler consults this set (live-proven in the
  // server re-proof SUP-422/SUP-401 + R7h control); this test pins the set
  // so a future edit cannot silently re-admit a fail-closed code.
  for (const code of ['hosted_unreachable', 'hosted_unavailable', 'hosted_bad_response']) {
    assert.equal(FALLBACK_ELIGIBLE_CODES.has(code), true, `${code} must stay fallback-eligible`);
  }
  for (const code of ['hosted_auth_failed', 'hosted_invalid_payload', 'hosted_not_found', 'hosted_rate_limited', 'hosted_unexpected_status']) {
    assert.equal(FALLBACK_ELIGIBLE_CODES.has(code), false, `${code} must NEVER fall back — not at verify, not at /supported`);
    assert.equal(FAIL_CLOSED_CODES.has(code), true, `${code} must be listed as fail-closed`);
  }
});

test('FIXBACK3 A2a: expected WITHOUT sender never confirms (CCD match + confirm levels)', async () => {
  const noSender = { amount: '500000', recipient: PAYEE, asset: 'CCD', payableId: 8 };
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, noSender), /no sender/);
  assert.match(matchSettleTxContents(RAIL_A_SUMMARY, { ...noSender, sender: '' }), /no sender/);
  // Confirm level: the real Rail-A hash with a stub gRPC returning its real
  // summary — no sender in expected -> unconfirmed, never confirmed.
  const out = await confirmSettleTxOnChain(RAIL_A_HASH, { grpc: grpcStub(RAIL_A_SUMMARY), expected: noSender });
  assert.equal(out.confirmed, false);
  assert.match(out.reason, /no sender|contents do not match/);
  // Control: the same hash WITH the sender confirms (the payment it belongs to).
  const outOk = await confirmSettleTxOnChain(RAIL_A_HASH, {
    grpc: grpcStub(RAIL_A_SUMMARY),
    expected: { sender: PAYER, amount: '500000', recipient: PAYEE, asset: 'CCD', payableId: 8 },
  });
  assert.equal(outOk.confirmed, true);
});

test('FIXBACK3 A2b: expected WITHOUT payableId never confirms a PLT transfer (memo check not skippable)', async () => {
  const wrongMemo = JSON.parse(JSON.stringify(TRANSFER9_SUMMARY));
  wrongMemo.events[0].memo = Buffer.from('payable:999', 'utf8').toString('hex');
  const noPayableId = { sender: PAYER, amount: '10000', recipient: PAYEE, asset: 'EUDemo' };
  // A transfer carrying memo payable:999 must NOT confirm when no payableId
  // was supplied — the old code skipped the memo check and returned null.
  assert.match(matchSettleTxContents(wrongMemo, noPayableId), /no payableId/);
  const out = await confirmSettleTxOnChain(RAIL_A_HASH, { grpc: grpcStub(wrongMemo), expected: noPayableId });
  assert.equal(out.confirmed, false);
  assert.match(out.reason, /no payableId|contents do not match/);
  // Control: the same transfer WITH payableId 999 and memo payable:999 confirms.
  assert.equal(matchSettleTxContents(wrongMemo, { ...noPayableId, payableId: 999 }), null);
  // And with payableId 9 it fails on the memo (not skipped, not matched).
  assert.match(matchSettleTxContents(wrongMemo, { ...noPayableId, payableId: 9 }), /memo/);
});

test('FIXBACK3 A2c: a PLT tx with the correct transfer PLUS a second drain confirms NOTHING', () => {
  // MF-X402-FB2-A2c (non-blocking): the correct transfer genuinely occurred,
  // so no false settle results — but the docstring claims a second transfer
  // is a mismatch, and the old code find()ed the matching event and ignored
  // the rest. Now the code matches the docstring: exactly one transfer.
  const twoTransfers = JSON.parse(JSON.stringify(TRANSFER9_SUMMARY));
  twoTransfers.events[0].memo = Buffer.from('payable:9', 'utf8').toString('hex');
  twoTransfers.events.push({
    tag: 'TokenTransfer', tokenId: 'EUDemo',
    from: { type: 'account', address: PAYER },
    to: { type: 'account', address: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB' },
    amount: { value: '999999', decimals: 6 }, memo: Buffer.from('payable:9', 'utf8').toString('hex'),
  });
  const pltExpected = { sender: PAYER, amount: '10000', recipient: PAYEE, asset: 'EUDemo', payableId: 9 };
  assert.match(matchSettleTxContents(twoTransfers, pltExpected), /exactly one settled transfer/);
  // Control: the same transfer alone (one event) still matches.
  const oneTransfer = JSON.parse(JSON.stringify(TRANSFER9_SUMMARY));
  oneTransfer.events[0].memo = Buffer.from('payable:9', 'utf8').toString('hex');
  assert.equal(matchSettleTxContents(oneTransfer, pltExpected), null);
});

test('FIXBACK3 B1: a tag-24 inner that is NOT the memo text itself fails memo-canonical (map key / double-wrapped / array element)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const memoHex = encodeCborMemo('payable:9').toString('hex'); // CBOR text encoding of 'payable:9' (10 bytes)
  const bindOps = async (opsHex) => verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_9),
    payload: { x402Version: 2, accepted: reqFor(EUD_VIEW_9), payload: { signedTransaction: { version: 1, header: {}, payload: { operations: opsHex }, signatures: {} } } },
    requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  // B2: tag-24 inner is a MAP {'payable:9': 1} — the memo is a map KEY, not a text memo.
  const mapKeyInner = await bindOps(`d8184ca1${memoHex}01`);
  assert.equal(mapKeyInner.isValid, false);
  assert.equal(mapKeyInner.invalidReason, 'memo_not_canonical');
  // B3: DOUBLE-wrapped tag-24 (tag24(tag24(text))) — not a memo string at all.
  const doubleWrapped = await bindOps(`d8184dd8184a${memoHex}`);
  assert.equal(doubleWrapped.isValid, false);
  assert.equal(doubleWrapped.invalidReason, 'memo_not_canonical');
  // B4: tag-24 inner is an ARRAY ['payable:9', 1] — the memo is an array element.
  const arrayInner = await bindOps(`d8184c82${memoHex}01`);
  assert.equal(arrayInner.isValid, false);
  assert.equal(arrayInner.invalidReason, 'memo_not_canonical');
  // Control: the genuine single tag-24 memo (the real PLT shape) still passes.
  const genuine = await bindOps(`d8184a${memoHex}`);
  assert.equal(genuine.isValid, true);
  // Walker-level: none of the three inner shapes credits a viaTag24 text.
  assert.ok(!extractCborTexts(`d8184ca1${memoHex}01`).some((t) => t.viaTag24 === true));
  assert.ok(!extractCborTexts(`d8184dd8184a${memoHex}`).some((t) => t.viaTag24 === true));
  assert.ok(!extractCborTexts(`d8184c82${memoHex}01`).some((t) => t.viaTag24 === true));
  assert.ok(extractCborTexts(`d8184a${memoHex}`).some((t) => t.text === 'payable:9' && t.viaTag24 === true));
});

test('FIXBACK3 B1: a second op carrying its own tag-24 memo fails memo-canonical (exactly one memo text)', async () => {
  // The fix-back-2 B1 residual as DOCUMENTED was "a second op with its own
  // tag-24 memo still passes". The genuine two-op case is now closed by the
  // exactly-one-viaTag24-text rule in checkPayableBinding: a real two-op
  // tokenUpdate (two transfers, each memo payable:9) carries two memo texts.
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { isValid: true, payer: PAYER }));
  const hosted = createHostedFacilitator({ apiKey: FAKE_KEY, fetchImpl });
  const selfHosted = fakeSelfHosted({ isValid: true, payer: PAYER });
  const op = () => ({
    transfer: {
      amount: TokenAmount.create(10000n, 6),
      recipient: CborAccountAddress.fromBase58(PAYEE),
      memo: CborMemo.fromString('payable:9'),
    },
  });
  const twoOpsHex = Buffer.from(Cbor.toBuffer(Cbor.encode([op(), op()]))).toString('hex');
  const out = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_9),
    payload: { x402Version: 2, accepted: reqFor(EUD_VIEW_9), payload: { signedTransaction: { version: 1, header: {}, payload: { operations: twoOpsHex }, signatures: {} } } },
    requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  assert.equal(out.isValid, false);
  assert.equal(out.invalidReason, 'memo_not_canonical');
  // Control: the single-op SDK fixture still passes.
  const outOk = await verifyPayableHostedFirst({
    hosted, selfHosted, loadPayable: loadPayable(EUD_VIEW_9),
    payload: pltPayloadWithMemo('payable:9'), requirements: reqFor(EUD_VIEW_9), payableId: 9, expectedStatus: 'Unpaid',
  });
  assert.equal(outOk.isValid, true);
});
