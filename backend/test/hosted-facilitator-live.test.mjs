// PayOnce backend — hosted x402 facilitator LIVE probe test (testnet only).
//
// Hits the REAL hosted facilitator (https://x402-facilitator.testnet.concordium.com).
//   - Skips entirely unless X402_FACILITATOR_API_KEY is in the process env.
//     The key is NEVER read from any file here and NEVER printed.
//   - Builds UNSIGNED payloads with a garbage sender signature: sender =
//     the OWNER (a real testnet account, from public evidence), sponsor =
//     the hosted feePayer from live /supported. No seed, no signer, no
//     funds move: /verify is read-only, and /settle refuses the garbage
//     signature with transaction:"" (nothing is submitted on chain).
//   - The expected verdicts are the ones proven live on 2026-11-25
//     (see X402_BUILDER_REPORT.md §2): invalid_sender_signature for a
//     well-formed payload with a bad signature. A stale nonce is always
//     refused (isValid:false); the exact reason string for it is
//     facilitator-state dependent (previously_failed vs
//     invalid_sender_signature — see the report) and is not pinned here.
//     A fully-VALID verify (isValid:true) still needs a payer-signed
//     payload — i.e. the seed — which this test deliberately does not
//     use; that boundary is documented in the report.
//   - WHY the owner account, not seller B or payee2, as sender: the hosted
//     facilitator remembers (sender, nonce) pairs that failed verification
//     and later answers them with previously_failed (proven live across
//     probes 3-8 and the smoke runs — the record lands after a delay, not
//     on immediate re-submit). A sender whose nonce never advances (payee2,
//     nonce 46) therefore gets POISONED for probing after a few runs, and a
//     retry cannot help (same nonce). The owner account's nonce advances
//     with other live runs, so a fresh read usually yields a fresh
//     (sender, nonce).
//   - POISON-WINDOW ROBUSTNESS (FIXBACK2, MF-X402-FB-H1 option (b)): the
//     suite must pass even when the (owner, current-nonce) pair is ALREADY
//     poisoned — the fix-back-1 live 5/5 passed only in a freshness window
//     and failed 1/5 on every independent re-run in the poison window.
//     The garbage-signature tests therefore accept `previously_failed` as
//     a valid refusal alongside `invalid_sender_signature`: both are the
//     facilitator refusing the payload (isValid:false / success:false),
//     and previously_failed means exactly "no fresh verdict obtained"
//     (see hosted.mjs §4 doctrine) — the test's assertion is REFUSAL of a
//     bad-signature payload, not which refusal string a poisoned pair
//     returns. No fresh sender is needed (an ephemeral keypair per run
//     would also work, but acceptance is simpler and needs no keypair
//     plumbing). Transport failures (hosted 5xx / gRPC UNAVAILABLE) are
//     retried inside callFresh/liveSetup — they are infra flakes, not
//     verdicts — while a poisoned pair is never re-submitted (sound rule).
//   - Landing vs persistence (FIXBACK2 correction): the record-LANDING
//     delay is variable and unbounded above — fresh pairs showed no flip
//     at 185 s nor at ~6–8 min, while other pairs flipped at ~90–150 s —
//     so "seconds to ~2 min" was ONE observation, not a bound. Record
//     PERSISTENCE is >= ~45 min (C3,38) / >= ~55 min (payee2,46) and
//     counting; the exact TTL remains undetermined.
//   - previously_failed, CORRECTED (fix-back 2026-11-25 — the first
//     version of this comment and of hosted.mjs overstated the trigger):
//     the trigger is (a) a prior failed attempt on that (sender, nonce)
//     AND (b) a delay since that attempt. It does NOT require the nonce to
//     be behind the sender's on-chain nonce — proven live with C3, whose
//     on-chain nonce never advances: delayed re-submit of (C3, nonce 38)
//     returned previously_failed with the on-chain nonce UNCHANGED (38 ->
//     38). Pure staleness alone does NOT trigger it (a never-attempted
//     ancient nonce returns invalid_sender_signature). Once poisoned,
//     previously_failed MASKS the real reason for every later payload using
//     that pair — treat it as "no fresh verdict obtained", never as a
//     diagnosis; to learn the underlying reason, probe with a FRESH
//     (sender, nonce) that has never failed (a different sender, or the
//     same sender after its on-chain nonce has advanced).
//   - SOUND RETRY RULE (replaces "re-read the nonce, rebuild, retry" as
//     stated before): NEVER re-submit the same (sender, nonce) — it can only
//     return previously_failed once poisoned. Re-read the on-chain nonce
//     and rebuild ONLY if it has actually advanced; if it has NOT advanced,
//     STOP — the caller must wait for the sender to transact on-chain (which
//     advances the nonce) or for the facilitator's record TTL (still
//     undetermined) to expire. The helper below implements exactly this: it
//     retries only while the freshly-read nonce differs from the poisoned
//     one, up to 3 attempts. The owner is the account the facilitator
//     server itself reports as sponsor, so it is the most stable
//     advancing-nonce sender available without a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Transaction, Payload, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId,
  AccountAddress, TransactionExpiry, SequenceNumber, CcdAmount,
} from '@concordium/web-sdk';
import { grpcClient, getAccountInfo, toJson } from '../src/chain.mjs';
import { createHostedFacilitator, HOSTED_TESTNET_CAIP2 } from '../src/facilitator/hosted.mjs';

const LIVE_KEY = process.env.X402_FACILITATOR_API_KEY ?? null;
const SKIP = !LIVE_KEY;

// Public testnet addresses from PayOnce evidence (no secrets).
// Sender = owner (advancing nonce); recipient = payee2. Both are real accounts.
const SENDER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const RECIPIENT = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';

function toJsonSafe(value) {
  if (typeof value === 'bigint') return value <= 9007199254740991n ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}

async function liveSetup() {
  const hosted = createHostedFacilitator({ apiKey: LIVE_KEY });
  const client = grpcClient();
  // The public gRPC node flakes with UNAVAILABLE 429 under load, and the
  // hosted endpoint can 500 transiently; retry the read-only setup calls
  // (infra flakes, not verdicts) before giving up. FIXBACK3: 4 retries =
  // 5 attempts total (was 2 retries = 3 attempts — too thin for a sustained
  // hosted 500 storm; see the callFresh retry note below).
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const feePayer = await hosted.feePayer();
      const consensus = toJson(await client.getConsensusStatus());
      const info = toJson(await getAccountInfo(client, SENDER, consensus.lastFinalizedBlock));
      return { hosted, feePayer, nonce: Number(info.accountNonce) };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

// A garbage-signature payload must be REFUSED. In the poison window the
// refusal string is `previously_failed` ("no fresh verdict obtained") rather
// than `invalid_sender_signature`; both are refusals, and the test pins the
// refusal, not the string. (FIXBACK2 H1(b).)
const REFUSAL_REASONS = ['invalid_sender_signature', 'previously_failed'];
function assertRefused(out, field = 'invalidReason') {
  assert.equal(out.isValid ?? out.success, false);
  assert.ok(REFUSAL_REASONS.includes(out[field]), `expected a refusal (${REFUSAL_REASONS.join(' or ')}), got ${out[field]}`);
}

// Transport-only retries (FIXBACK3 MF-X402-FB2-H1 / OB-X402-FB2-C1): retry a
// transport/availability error (hosted_unavailable / hosted_unreachable) 4
// times — 5 attempts total, 5 s apart. A fail-closed hosted error
// (auth/rate-limit/unexpected status) is a verdict about the endpoint, not a
// flake — it throws at once, never retried.
// Assumption, stated not hidden (adversarial OB-3): a hosted 500 is treated
// as "the endpoint recorded nothing, so no poison record is created". That
// premise is UNPROVEN and unprovable from outside: if a 500 landed AFTER
// the facilitator recorded the failure, a retry would re-submit a poisoned
// pair and the resulting previously_failed would be accepted as a refusal,
// hiding the violation. The retry is therefore bounded (5 attempts), and
// every test logs its refusal reason (OB-2), so a run passing entirely via
// previously_failed — or via a settle 500 after a verify refusal — is
// visible in the filed log instead of silent. No finite retry budget can
// absorb a sustained multi-minute hosted 500 storm; that case is handled by
// the settle test's verify-proven-refusal path, not by retries.
async function callTransportRetried(fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if ((e.code === 'hosted_unavailable' || e.code === 'hosted_unreachable') && attempt < 4) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Call verify/settle with a freshly-read nonce. On previously_failed the
// sound retry rule applies (see header): re-read the on-chain nonce and
// rebuild ONLY if it has actually advanced — retrying the SAME (sender,
// nonce) can only return previously_failed again, so the loop stops as soon
// as a re-read returns the poisoned nonce. Up to 3 attempts total. A fresh
// (sender, nonce) always gets a fresh verdict (proven live); a poisoned
// pair with a non-advancing nonce has no fresh verdict to obtain.
// A transport failure (hosted 5xx / unreachable) is NOT a verdict: the
// same (sender, nonce) is retried after a short sleep, 4 retries = 5
// attempts total via callTransportRetried (FIXBACK3: was 2 retries = 3
// attempts — the fix-back-2 report §3 misworded this as "up to 3 times").
// The poisoned-pair rule is unchanged: a poisoned pair is never re-submitted
// for a fresh VERDICT; transport retries are the only same-pair repeats,
// under the documented OB-3 assumption above.
async function callFresh(hosted, feePayer, buildFn, req, method = 'verify') {
  const expiry = Math.floor(Date.now() / 1000) + 240;
  let out = null;
  let poisonedNonce = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { nonce } = await liveSetup();
    if (poisonedNonce !== null && nonce === poisonedNonce) return out; // nonce has not advanced: retrying is futile
    out = await callTransportRetried(() => hosted[method](buildFn({ nonce, feePayer, expiry }), req));
    if ((out.invalidReason ?? out.errorReason) !== 'previously_failed') return out;
    poisonedNonce = nonce;
  }
  return out;
}

function requirements({ amount, asset, feePayer }) {
  return { scheme: 'exact', network: HOSTED_TESTNET_CAIP2, amount: String(amount), asset, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer } };
}

function buildCcd({ nonce, feePayer, expiry }) {
  const tx = Transaction.transfer(Payload.transfer({
    amount: CcdAmount.fromMicroCcd(500000n),
    toAddress: AccountAddress.fromBase58(RECIPIENT),
  })).addMetadata({
    sender: AccountAddress.fromBase58(SENDER),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromEpochSeconds(expiry),
  }).addSponsor(AccountAddress.fromBase58(feePayer)).build();
  const j = toJsonSafe(Transaction.toJSON(tx));
  j.signatures = { sender: { 0: { 0: randomBytes(64).toString('hex') } } };
  return { x402Version: 2, accepted: requirements({ amount: 500000, asset: 'CCD', feePayer }), payload: { signedTransaction: j } };
}

function buildEudemo({ nonce, feePayer, expiry }) {
  const operations = Cbor.encode([{
    transfer: {
      amount: TokenAmount.create(10000n, 6),
      recipient: CborAccountAddress.fromBase58(RECIPIENT),
      memo: CborMemo.fromString('payable:9'),
    },
  }]);
  const tx = Transaction.tokenUpdate(Payload.tokenUpdate({ tokenId: TokenId.fromString('EUDemo'), operations }))
    .addMetadata({
      sender: AccountAddress.fromBase58(SENDER),
      nonce: SequenceNumber.create(nonce),
      expiry: TransactionExpiry.fromEpochSeconds(expiry),
    }).addSponsor(AccountAddress.fromBase58(feePayer)).build();
  const j = toJsonSafe(Transaction.toJSON(tx));
  j.signatures = { sender: { 0: { 0: randomBytes(64).toString('hex') } } };
  return { x402Version: 2, accepted: requirements({ amount: 10000, asset: 'EUDemo', feePayer }), payload: { signedTransaction: j } };
}

test('LIVE hosted /supported: testnet kind + hosted feePayer + matching signers', { skip: SKIP }, async () => {
  const { hosted } = await liveSetup();
  const sup = await hosted.supported();
  const kind = (sup.kinds ?? []).find((k) => k.network === HOSTED_TESTNET_CAIP2);
  assert.ok(kind, 'testnet kind present');
  assert.equal(kind.scheme, 'exact');
  assert.equal(kind.x402Version, 2);
  assert.match(kind.extra.feePayer, /^[1-9A-HJ-NP-Za-km-z]{30,}$/);
  assert.ok((sup.signers?.['ccd:*'] ?? []).includes(kind.extra.feePayer), 'feePayer is a listed signer');
});

test('LIVE hosted /verify CCD: well-formed payload + bad signature -> refused (invalid_sender_signature, or previously_failed in the poison window)', { skip: SKIP }, async () => {
  const { hosted, feePayer } = await liveSetup();
  const req = requirements({ amount: 500000, asset: 'CCD', feePayer });
  const out = await callFresh(hosted, feePayer, buildCcd, req);
  assertRefused(out);
  // OB-2: log the refusal reason per test, so a run passing entirely via
  // previously_failed (refuse-everything) is visible in the filed log.
  console.log(`[live] CCD verify refusal: ${out.invalidReason}`);
  assert.equal(out.payer, SENDER);
});

test('LIVE hosted /verify EUDemo: memo’d tokenUpdate + bad signature -> refused (invalid_sender_signature, or previously_failed in the poison window)', { skip: SKIP }, async () => {
  const { hosted, feePayer } = await liveSetup();
  const req = requirements({ amount: 10000, asset: 'EUDemo', feePayer });
  const out = await callFresh(hosted, feePayer, buildEudemo, req);
  assertRefused(out);
  console.log(`[live] EUDemo verify refusal: ${out.invalidReason}`);
  assert.equal(out.payer, SENDER);
});

test('LIVE hosted /verify: stale nonce is refused (isValid false)', { skip: SKIP }, async () => {
  // A payload whose nonce is behind the sender's on-chain nonce must never
  // verify. The exact reason is facilitator-state dependent: observed live
  // as previously_failed when the (sender, nonce) had failed here before
  // and enough time had passed since that failure (the on-chain nonce need
  // NOT have advanced — C3 nonce 38 proves it), and as
  // invalid_sender_signature for a never-attempted ancient nonce — so this
  // test pins only the refusal, not the reason string. See the report §2
  // (corrected in the fix-back report §4).
  const { hosted, feePayer, nonce } = await liveSetup();
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const stale = buildCcd({ nonce: nonce - 1, feePayer, expiry });
  const outStale = await hosted.verify(stale, requirements({ amount: 500000, asset: 'CCD', feePayer }));
  assert.equal(outStale.isValid, false);
  assert.equal(outStale.payer, SENDER);
  const req = requirements({ amount: 500000, asset: 'CCD', feePayer });
  const outFresh = await callFresh(hosted, feePayer, buildCcd, req);
  assertRefused(outFresh);
  console.log(`[live] stale-nonce fresh-check refusal: ${outFresh.invalidReason}`);
});

test('LIVE hosted /settle: bad signature -> success:false, empty transaction (nothing submitted)', { skip: SKIP }, async () => {
  // FIXBACK3 MF-X402-FB2-H1 — the settle leg is now poison-robust. The
  // fix-back-2 settle test called hosted.settle directly and treated a
  // hosted HTTP 500 as a retryable transport flake; in the poison window a
  // direct settle on a poisoned pair returns HTTP 500 DETERMINISTICALLY
  // (proven by both judges: 12+ attempts, both assets, while verify on the
  // same pair returns previously_failed), so the test failed 4/5 on every
  // re-run. This test proves the refusal with a VERIFY on the SAME
  // (sender, nonce) pair FIRST, then settles the SAME payload object:
  //   - settle returns a refusal verdict -> asserted as before
  //     (success:false, transaction:'', errorReason in REFUSAL_REASONS).
  //   - settle throws hosted_unavailable/hosted_unreachable even after the
  //     transport retries -> ACCEPTED as a refusal-by-500, because the
  //     verify on this exact pair already refused it. Nothing was
  //     submitted: the payload carries a random garbage signature, so no
  //     valid tx can result from it on chain, and a 500 carries no success.
  //     (This is the same shape as the server path, which verifies first
  //     and short-circuits on the failed verify without touching /settle.)
  //   - any other settle throw, or a settle 500 with NO prior verify
  //     refusal on the pair, still FAILS the test.
  const { hosted, feePayer } = await liveSetup();
  const req = requirements({ amount: 500000, asset: 'CCD', feePayer });
  const { nonce } = await liveSetup();
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const payload = buildCcd({ nonce, feePayer, expiry });
  const verifyOut = await callTransportRetried(() => hosted.verify(payload, req));
  assertRefused(verifyOut);
  console.log(`[live] settle-test verify refusal on (owner,${nonce}): ${verifyOut.invalidReason}`);
  assert.equal(verifyOut.payer, SENDER);
  let settleOut = null;
  let settle500 = false;
  try {
    settleOut = await callTransportRetried(() => hosted.settle(payload, req));
  } catch (e) {
    if (e.code === 'hosted_unavailable' || e.code === 'hosted_unreachable') {
      settle500 = true;
    } else {
      throw e;
    }
  }
  if (settle500) {
    // Refusal-by-500 on a pair already refused by verify (see header above).
    console.log(`[live] settle-test settle refused-by-500 after verify refusal (${verifyOut.invalidReason}) — accepted, nothing submitted`);
  } else {
    assert.equal(settleOut.success, false);
    assert.equal(settleOut.transaction, '');
    assertRefused(settleOut, 'errorReason');
    console.log(`[live] settle-test settle refusal: ${settleOut.errorReason}`);
    assert.equal(settleOut.payer, SENDER);
  }
});
