// Verification of Payee: decision core, v3 byte layouts, relayer guards, check_payee orchestration (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Transaction, Payload, AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, SequenceNumber,
  TransactionExpiry, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId, buildBasicAccountSigner,
} from '@concordium/web-sdk';
import { decideVop, compareLegalNames, legalNameHash, normalizeLegalName, evidenceHash, presentationAnchor, canonicalJson, VERDICT, sha256Hex } from '../src/vop.mjs';
import { serPayeeIdentity, serProposePayee, serAcceptPayee, serAcknowledgePayee, serRegisterPayable, parsePayeeRecord, parsePayeeAck, parsePayableV3, parseConfigV3, credentialsOf, V3 } from '../src/vop-chain.mjs';
import { inspectSponsored, memoText, toJsonSafe, RelayError } from '../src/relayer.mjs';
import { createVopService, factsFromPresentation } from '../src/vop-service.mjs';

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const PAYEE = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const FRAUD = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n';
const BUYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const CRED = 'a'.repeat(96);
const NOW = 1_800_000_000_000;

// ---------- names ----------
test('name match: one matcher, EPC-style verdicts', () => {
  assert.equal(compareLegalNames('Acme GmbH', 'ACME G.m.b.H.').result, VERDICT.MATCH);
  assert.equal(compareLegalNames('Müller Bau GmbH', 'Mueller Bau GmbH').result, VERDICT.MATCH);
  assert.equal(compareLegalNames('Acme GmbH', 'Acme Holding GmbH').result, VERDICT.CLOSE_MATCH);
  assert.equal(compareLegalNames('Acme GmbH', 'Evil Ltd').result, VERDICT.NO_MATCH);
  assert.equal(compareLegalNames('Elin Berglund', 'Elin Berglun').result, VERDICT.CLOSE_MATCH);
  assert.equal(compareLegalNames('Elin Berglund', 'Ellen Berglund').result, VERDICT.CLOSE_MATCH);
  assert.equal(compareLegalNames('Elin Berglund', 'E. Berglund').result, VERDICT.NO_MATCH);
  assert.equal(normalizeLegalName('Studio Nour Ltd'), normalizeLegalName('NOUR STUDIO'));
  assert.equal(legalNameHash('Acme GmbH'), legalNameHash('ACME G.m.b.H.'));
  assert.notEqual(legalNameHash('Acme GmbH'), legalNameHash('Acme Holding GmbH'));
});

// ---------- decision ----------
const book = (over = {}) => ({ status: 'Bound', version: 1, mature_at_ms: NOW - 1000, identity: { legal_name_hash: legalNameHash('Acme GmbH') }, ...over });
const acct = (idp = 4) => ({ exists: true, credentials: [{ credId: CRED, idp }] });
const proof = (revealed, idp = 4, over = {}) => ({ valid: true, anchor: 'x', anchorOnChain: 'x', facts: { credIds: [CRED], idpIndexes: [idp], revealed, given: {} }, ...over });

test('decide: business proof, bound + matured book -> MATCH, payable', () => {
  const r = decideVop({ invoice: { legal_name: 'ACME GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH', legalCountry: 'DE' }), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.MATCH); assert.equal(r.payable, true); assert.equal(r.identity_kind, 'business'); assert.equal(r.verified_country, 'DE');
});
test('decide: cooling-off not over -> MATCH but not payable', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }), book: book({ mature_at_ms: NOW + 60_000 }), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.MATCH); assert.equal(r.payable, false);
  assert.equal(r.checks.find((c) => c.id === 'cooling_off_over').ok, false);
});
test('decide: payee not bound (bank details changed by e-mail) -> not payable', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }), book: { status: 'NotBound', version: 0, mature_at_ms: null, identity: null }, nowMs: NOW });
  assert.equal(r.payable, false);
});
test('decide: personal identity, EU-nationality proof, company name on invoice -> NO_MATCH', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(0), proof: proof({ nationality: 'DK' }, 0), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.NO_MATCH); assert.equal(r.payable, false); assert.equal(r.identity_kind, 'person');
});
test('decide: sole trader (person name proof) -> MATCH on the person name', () => {
  const r = decideVop({ invoice: { legal_name: 'Hassan Nour' }, account: acct(0), proof: proof({ firstName: 'Nour', lastName: 'Hassan' }, 0), book: book({ identity: { legal_name_hash: legalNameHash('Nour Hassan') } }), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.MATCH); assert.equal(r.payable, true);
});
test('decide: different business name -> NO_MATCH', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Evil Payments Ltd' }), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.NO_MATCH); assert.equal(r.payable, false);
});
test('decide: close match is never payable', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme Holding GmbH' }), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.CLOSE_MATCH); assert.equal(r.payable, false);
  assert.match(r.reasons[0], /Did you mean "Acme Holding GmbH"/);
});
test('decide: proof from a credential of ANOTHER account -> UNVERIFIED', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }, 4, { facts: { credIds: ['b'.repeat(96)], idpIndexes: [4], revealed: { legalName: 'Acme GmbH' }, given: {} } }), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.UNVERIFIED); assert.equal(r.payable, false);
});
test('decide: presentation that fails node verification -> UNVERIFIED', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }, 4, { valid: false, error: 'bad proof' }), book: book(), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.UNVERIFIED);
});
test('decide: book bound to another name than the proof -> not payable', () => {
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }), book: book({ identity: { legal_name_hash: legalNameHash('Other GmbH') } }), nowMs: NOW });
  assert.equal(r.verdict, VERDICT.MATCH); assert.equal(r.payable, false);
});
test('decide: no proof -> UNVERIFIED (verification not possible), never a match', () => {
  assert.equal(decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(0), book: book(), nowMs: NOW }).verdict, VERDICT.UNVERIFIED);
  assert.equal(decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(4), book: book(), nowMs: NOW }).verdict, VERDICT.UNVERIFIED);
});
test('decide: account missing -> NO_MATCH', () => {
  assert.equal(decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: { exists: false }, nowMs: NOW }).verdict, VERDICT.NO_MATCH);
});
test('decide: stand-in is labelled and needs the book to agree', () => {
  const st = { legal_name: 'Acme GmbH', country: 'DK', label: 'TESTNET STAND-IN' };
  const r = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(0), book: book(), nowMs: NOW, standin: st });
  assert.equal(r.verdict, VERDICT.MATCH); assert.equal(r.standin, true); assert.equal(r.payable, true);
  assert.match(r.reasons.join(' '), /STAND-IN/);
  const r2 = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(0), book: book({ identity: { legal_name_hash: legalNameHash('X') } }), nowMs: NOW, standin: st });
  assert.equal(r2.payable, false);
});
test('evidence hash is deterministic and changes with the verdict', () => {
  const a = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }), book: book(), nowMs: NOW });
  const b = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Acme GmbH' }), book: book(), nowMs: NOW });
  const c = decideVop({ invoice: { legal_name: 'Acme GmbH' }, account: acct(), proof: proof({ legalName: 'Evil Ltd' }), book: book(), nowMs: NOW });
  assert.equal(evidenceHash(a), evidenceHash(b)); assert.notEqual(evidenceHash(a), evidenceHash(c));
  assert.equal(presentationAnchor({ b: 1, a: [2, { d: 3, c: 4 }] }), sha256Hex('{"a":[2,{"c":4,"d":3}],"b":1}'));
});

// ---------- byte layouts (mirror lib.rs) ----------
const A = (a) => Buffer.from(AccountAddress.fromBase58(a).decodedAddress);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const H = (c) => Buffer.alloc(32, c);
const identity = { kind: 1, idp_index: 4, legal_name_hash: H(1).toString('hex'), country: 'DE', proof_anchor: H(2).toString('hex'), anchor_tx: null };

test('serializers: PayeeIdentity / propose / accept / ack / register', () => {
  const id = serPayeeIdentity(identity);
  assert.equal(id.length, 1 + 4 + 32 + 2 + 32 + 1);
  assert.equal(id[0], 1); assert.equal(id.readUInt32LE(1), 4); assert.equal(id.subarray(37, 39).toString(), 'DE');
  assert.equal(serPayeeIdentity({ ...identity, anchor_tx: H(3).toString('hex') }).length, 72 + 32);
  assert.throws(() => serPayeeIdentity({ ...identity, country: 'D1' }));
  assert.throws(() => serPayeeIdentity({ ...identity, kind: 3 }));
  assert.equal(serProposePayee({ payee: PAYEE, agent_token: 1476, identity }).length, 32 + 8 + 72);
  assert.deepEqual(serAcceptPayee({ seller: SELLER, version: 2, proof_anchor: H(2).toString('hex') }), Buffer.concat([A(SELLER), u32(2), H(2)]));
  assert.deepEqual(serAcknowledgePayee({ seller: SELLER, payee: PAYEE, version: 1, verdict: 0, evidence_hash: H(9).toString('hex') }), Buffer.concat([A(SELLER), A(PAYEE), u32(1), Buffer.from([0]), H(9)]));
  const reg = serRegisterPayable({ payable_id: 7, payee: PAYEE, amount: 1000, asset: 'EUDemo', due_ms: NOW, doc_hash: H(5).toString('hex'), agent_token: 1476, expected_payer: BUYER, legal_ref: null });
  assert.deepEqual(reg, Buffer.concat([u64(7), A(PAYEE), u64(1000), Buffer.from([1]), u32(6), Buffer.from('EUDemo'), u64(NOW), H(5), u64(1476), Buffer.from([1]), A(BUYER), Buffer.from([0])]));
});

test('parsers: Option<PayeeRecord>, Option<PayeeAck>, Config, Option<Payable> v3', () => {
  assert.equal(parsePayeeRecord(Buffer.from([0])), null);
  const rec = Buffer.concat([Buffer.from([1]), A(SELLER), A(PAYEE), serPayeeIdentity(identity), Buffer.from([1]), u32(3), u64(NOW), Buffer.from([1]), u64(NOW + 1), Buffer.from([1]), u64(NOW + 600_000)]);
  const r = parsePayeeRecord(rec);
  assert.equal(r.seller, SELLER); assert.equal(r.payee, PAYEE); assert.equal(r.status, 'Bound'); assert.equal(r.version, 3);
  assert.equal(r.identity.country, 'DE'); assert.equal(r.identity.idp_index, 4); assert.equal(r.mature_at_ms, NOW + 600_000); assert.equal(r.identity.anchor_tx, null);
  assert.throws(() => parsePayeeRecord(Buffer.concat([rec, Buffer.from([0])])), /trailing/);
  const ack = parsePayeeAck(Buffer.concat([Buffer.from([1]), u32(3), Buffer.from([0]), H(7), u64(NOW)]));
  assert.deepEqual(ack, { version: 3, verdict: 0, evidence_hash: H(7).toString('hex'), at_ms: NOW });
  assert.deepEqual(parseConfigV3(Buffer.concat([u64(12802), u64(0), u64(3600), u64(600)])), { cis8004: '<12802,0>', reservation_secs: 3600, cooling_off_secs: 600 });
  const pay = Buffer.concat([Buffer.from([1]), A(SELLER), u64(7), A(PAYEE), u64(1000), Buffer.from([1]), u32(6), Buffer.from('EUDemo'), u64(NOW), H(5), u64(1476), Buffer.from([0]), Buffer.from([0]), u32(2), Buffer.from([1]), A(BUYER), u64(NOW), u64(NOW + 3600_000)]);
  const p = parsePayableV3(pay);
  assert.equal(p.payee_version, 2); assert.equal(p.asset, 'EUDemo'); assert.equal(p.status.tag, 'Reserved'); assert.equal(p.status.payer, BUYER);
});

test('credentialsOf reads the identity-provider index of each credential', () => {
  const info = { accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: { credId: CRED.toUpperCase(), ipIdentity: 0 } } } } };
  assert.deepEqual(credentialsOf(info), [{ credId: CRED, idp: 0, type: 'normal' }]);
});

// ---------- relayer guards ----------
const SPONSOR = SELLER;
async function signedUpdate({ entrypoint = 'acknowledge_payee', contract = [V3.index, V3.subindex], amount = 0n, energy = 5000n, minutes = 5, sponsor = SPONSOR } = {}) {
  const s = buildBasicAccountSigner(randomBytes(32).toString('hex'));
  const payload = Payload.updateContract({ amount: CcdAmount.fromMicroCcd(amount), address: ContractAddress.create(contract[0], contract[1]), receiveName: ReceiveName.fromString(`payable_registry_v3.${entrypoint}`), message: Parameter.fromHexString('00') });
  const tx = Transaction.updateContract(payload, Energy.create(energy)).addMetadata({ sender: AccountAddress.fromBase58(BUYER), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(minutes) }).addSponsor(AccountAddress.fromBase58(sponsor)).build();
  return Transaction.signableFromJSON(toJsonSafe(Transaction.toJSON(await Transaction.sign(tx, s))));
}
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof RelayError, e.message); return e.code; } };

test('relayer: sponsors whitelisted v3 calls only', async () => {
  assert.equal(inspectSponsored(await signedUpdate(), { sponsorAddress: SPONSOR }).entrypoint, 'acknowledge_payee');
  assert.equal(code(() => inspectSponsored(null, { sponsorAddress: SPONSOR })), 'not_sponsored');
});
test('relayer: refuses other contracts, entrypoints, attached CCD, energy, expiry, wrong sponsor', async () => {
  assert.equal(code(() => inspectSponsored(fx.otherContract, { sponsorAddress: SPONSOR })), 'wrong_contract');
  assert.equal(code(() => inspectSponsored(fx.badEntry, { sponsorAddress: SPONSOR })), 'entrypoint_not_sponsored');
  assert.equal(code(() => inspectSponsored(fx.ccd, { sponsorAddress: SPONSOR })), 'ccd_attached');
  assert.equal(inspectSponsored(fx.payCcd, { sponsorAddress: SPONSOR }).entrypoint, 'pay_ccd');
  assert.equal(code(() => inspectSponsored(fx.energy, { sponsorAddress: SPONSOR })), 'energy_cap');
  assert.equal(code(() => inspectSponsored(fx.longExpiry, { sponsorAddress: SPONSOR })), 'bad_expiry');
  assert.equal(code(() => inspectSponsored(fx.ok, { sponsorAddress: BUYER })), 'wrong_sponsor');
  assert.equal(code(() => inspectSponsored({ ...fx.ok, signatures: { sender: {} } }, { sponsorAddress: SPONSOR })), 'unsigned');
});
const fx = {};
test.before(async () => {
  fx.ok = await signedUpdate();
  fx.otherContract = await signedUpdate({ contract: [13150n, 0n] });
  fx.badEntry = await signedUpdate({ entrypoint: 'set_config' });
  fx.ccd = await signedUpdate({ amount: 5n });
  fx.payCcd = await signedUpdate({ entrypoint: 'pay_ccd', amount: 5n });
  fx.energy = await signedUpdate({ energy: 100_000n });
  fx.longExpiry = await signedUpdate({ minutes: 30 });
});

test('relayer: EUDemo transfers need one transfer with a payable memo', async () => {
  const s = buildBasicAccountSigner(randomBytes(32).toString('hex'));
  const mk = async (ops, token = 'EUDemo') => {
    const tx = Transaction.tokenUpdate(Payload.tokenUpdate({ tokenId: TokenId.fromString(token), operations: Cbor.encode(ops) })).addMetadata({ sender: AccountAddress.fromBase58(BUYER), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) }).addSponsor(AccountAddress.fromBase58(SPONSOR)).build();
    return Transaction.signableFromJSON(toJsonSafe(Transaction.toJSON(await Transaction.sign(tx, s))));
  };
  const t = (memo) => ({ transfer: { amount: TokenAmount.create(1000n, 6), recipient: CborAccountAddress.fromBase58(PAYEE), memo: CborMemo.fromString(memo) } });
  const okTx = await mk([t(`payable:${SELLER}:7`)]);
  const f = inspectSponsored(okTx, { sponsorAddress: SPONSOR });
  assert.deepEqual([f.kind, f.transfer.recipient, f.transfer.amount, f.transfer.seller, f.transfer.payable_id], ['token', PAYEE, 1000n, SELLER, '7']);
  fx.tokenTwo = await mk([t(`payable:${SELLER}:7`), t(`payable:${SELLER}:8`)]);
  assert.equal(code(() => inspectSponsored(fx.tokenTwo, { sponsorAddress: SPONSOR })), 'one_transfer_only');
  const hello = await mk([t('hello')]);
  assert.equal(code(() => inspectSponsored(hello, { sponsorAddress: SPONSOR })), 'memo_required');
  assert.equal(memoText(CborMemo.fromString('payable:x:1')), 'payable:x:1');
});

// ---------- check_payee orchestration (fake chain) ----------
function fakeService({ record, idp = 4, presentation, ok = true, kv = {} }) {
  const store = new Map(Object.entries(kv));
  const enc = (ns, k) => `${ns}|${k}`;
  const c = {
    async getAccountInfo() { return { accountCredentials: { 0: { value: { type: 'normal', contents: { credId: CRED, ipIdentity: idp } } } } }; },
    async invokeContract({ method }) {
      const m = String(method.value ?? method);
      if (m.endsWith('get_payee')) return { tag: 'success', returnValue: record ?? Buffer.from([0]) };
      if (m.endsWith('get_ack')) return { tag: 'success', returnValue: Buffer.from([0]) };
      throw new Error(`unexpected ${m}`);
    },
  };
  const kvApi = { get: async (ns, k) => store.get(enc(ns, k)) ?? null, put: async (ns, k, v) => { store.set(enc(ns, k), v); } };
  if (presentation) store.set(enc('vop_proof', presentationAnchor(presentation)), { presentation, version: 'v1' });
  return createVopService({ grpc: async () => c, kv: kvApi, verifyPresentation: async () => ({ ok, reason: ok ? null : 'refused' }), now: () => NOW });
}
const pres = (revealed, idp = 4) => ({
  type: 'VerifiablePresentation', presentationContext: { given: [{ label: 'Nonce', context: 'ab' }] },
  verifiableCredential: [{ issuer: `did:ccd:testnet:idp:${idp}`, credentialSubject: { id: `did:ccd:testnet:cred:${CRED}`, statement: Object.entries(revealed).map(([k, v]) => ({ type: 'AttributeValue', attributeTag: k, attributeValue: v })) } }],
});
const recordBuf = (anchorHex, nameHash, { status = 1, mature = NOW - 1 } = {}) => Buffer.concat([Buffer.from([1]), A(SELLER), A(PAYEE), serPayeeIdentity({ ...identity, legal_name_hash: nameHash, proof_anchor: anchorHex }), Buffer.from([status]), u32(1), u64(NOW - 700_000), Buffer.from([1]), u64(NOW - 600_000), Buffer.from([1]), u64(mature)]);

test('factsFromPresentation pulls cred ids, issuer, revealed values, Nonce', () => {
  const f = factsFromPresentation(pres({ legalName: 'Acme GmbH', legalCountry: 'DE' }));
  assert.deepEqual(f.credIds, [CRED]); assert.deepEqual(f.idpIndexes, [4]); assert.equal(f.revealed.legalName, 'Acme GmbH'); assert.equal(f.given.Nonce, 'ab');
});
test('check_payee: bound business payee -> MATCH, payable, ack parameter offered', async () => {
  const p = pres({ legalName: 'Acme GmbH', legalCountry: 'DE' });
  const svc = fakeService({ presentation: p, record: recordBuf(presentationAnchor(p), legalNameHash('Acme GmbH')) });
  const r = await svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'ACME GmbH', buyer: BUYER });
  assert.equal(r.verdict, 'MATCH'); assert.equal(r.payable, true); assert.match(r.evidence_hash, /^[0-9a-f]{64}$/);
  assert.ok(r.acknowledge.parameter.endsWith(r.evidence_hash)); assert.equal(r.buyer_ack, null);
});
test('check_payee: node refuses the stored presentation -> UNVERIFIED', async () => {
  const p = pres({ legalName: 'Acme GmbH' });
  const svc = fakeService({ presentation: p, ok: false, record: recordBuf(presentationAnchor(p), legalNameHash('Acme GmbH')) });
  const r = await svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' });
  assert.equal(r.verdict, 'UNVERIFIED'); assert.equal(r.payable, false); assert.equal(r.acknowledge, null);
});
test('check_payee: personal identity, nationality-only proof -> NO_MATCH', async () => {
  const p = pres({ nationality: 'DK' }, 0);
  const svc = fakeService({ idp: 0, presentation: p, record: recordBuf(presentationAnchor(p), legalNameHash('Acme GmbH')) });
  const r = await svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' });
  assert.equal(r.verdict, 'NO_MATCH'); assert.equal(r.payable, false);
});
test('check_payee: unbound account (changed bank details) -> not payable', async () => {
  const svc = fakeService({ record: null });
  const r = await svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' });
  assert.equal(r.payable, false); assert.equal(r.subject.book.status, 'NotBound');
});
test('check_payee: stand-in is used only when its hash is the anchor on chain', async () => {
  const st = { legal_name: 'Acme GmbH', country: 'DK', label: 'TESTNET STAND-IN' };
  const anchor = sha256Hex(canonicalJson(st));
  const svc = fakeService({ idp: 0, kv: { [`vop_standin|${PAYEE}`]: st }, record: recordBuf(anchor, legalNameHash('Acme GmbH')) });
  const r = await svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' });
  assert.equal(r.verdict, 'MATCH'); assert.equal(r.standin, true); assert.equal(r.payable, true);
  const svc2 = fakeService({ idp: 0, kv: { [`vop_standin|${PAYEE}`]: st }, record: recordBuf('ee'.repeat(32), legalNameHash('Acme GmbH')) });
  assert.notEqual((await svc2.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' })).payable, true);
});
test('check_payee: input validation', async () => {
  const svc = fakeService({});
  await assert.rejects(svc.check({ seller: 'x', payee: PAYEE, legal_name: 'A' }), /addresses/);
  await assert.rejects(svc.check({ seller: SELLER, payee: PAYEE, legal_name: '' }), /legal_name/);
});
test('submitProof: verifies, checks the holder, stores by anchor, returns the identity tuple', async () => {
  const svc = fakeService({});
  const p = pres({ legalName: 'Acme GmbH', legalCountry: 'DE' });
  const r = await svc.submitProof({ payee: PAYEE, presentation: p });
  assert.equal(r.anchor, presentationAnchor(p)); assert.equal(r.identity.kind, 1); assert.equal(r.identity.country, 'DE');
  assert.equal(r.identity.legal_name_hash, legalNameHash('Acme GmbH'));
  assert.equal((await svc.getProof(r.anchor)).recomputed_anchor, r.anchor);
  const other = pres({ legalName: 'Acme GmbH' }); other.verifiableCredential[0].credentialSubject.id = `did:ccd:testnet:cred:${'c'.repeat(96)}`;
  await assert.rejects(svc.submitProof({ payee: PAYEE, presentation: other }), /not a credential of that account/);
});
test('check_payee: a rate-limited node gives no verdict (503), never a cached failure', async () => {
  const p = pres({ legalName: 'Acme GmbH' });
  const svc = createVopService({
    grpc: async () => ({ async getAccountInfo() { return { accountCredentials: { 0: { value: { contents: { credId: CRED, ipIdentity: 4 } } } } }; }, async invokeContract({ method }) { return { tag: 'success', returnValue: String(method.value ?? method).endsWith('get_payee') ? recordBuf(presentationAnchor(p), legalNameHash('Acme GmbH')) : Buffer.from([0]) }; } }),
    kv: { get: async (ns, k) => (ns === 'vop_proof' ? { presentation: p, version: 'v1' } : null), put: async () => {} },
    verifyPresentation: async () => ({ ok: false, reason: 'HTTP 429', transient: true }), now: () => NOW,
  });
  await assert.rejects(svc.check({ seller: SELLER, payee: PAYEE, legal_name: 'Acme GmbH' }), (e) => e.status === 503 && e.code === 'node_busy');
});

test('diagnose: a wallet presentation -> verified, holder account, single credential, name, anchor; stores nothing', async () => {
  const p = pres({ legalName: 'Acme GmbH' });
  let stored = 0;
  const mk = (ok, reason, creds = 1) => createVopService({
    grpc: async () => ({ async getAccountInfo() { return { accountAddress: PAYEE, accountThreshold: 1, accountCredentials: Object.fromEntries([...Array(creds)].map((_, i) => [i, { value: { contents: { credId: CRED, ipIdentity: 4 } } }])) }; } }),
    kv: { get: async () => null, put: async () => { stored++; } },
    verifyPresentation: async () => ({ ok, reason }), now: () => NOW,
  });
  const r = await mk(true, null).diagnose({ presentation: JSON.stringify(p), account: PAYEE });
  assert.equal(r.verified, true); assert.equal(r.holders[0].account, PAYEE); assert.equal(r.holders[0].single_credential, true);
  assert.equal(r.account_matches, true); assert.equal(r.name, 'Acme GmbH'); assert.equal(r.kind, 'business'); assert.equal(r.anchor, presentationAnchor(p)); assert.equal(stored, 0);
  const bad = await mk(false, 'the credential was not valid (index 0)', 2).diagnose({ presentation: p });
  assert.equal(bad.verified, false); assert.equal(bad.holders[0].single_credential, false);
  assert.ok(bad.hints.some((h) => /not produced from the credential/.test(h))); assert.ok(bad.hints.some((h) => /single-credential/.test(h)));
});

// ---------- sponsor-first relayer (wallet adds the sender signature) ----------
import { createRelayer } from '../src/relayer.mjs';
function fakeRelayer({ invokeOk = true, sponsorMicro = 5_000_000_000n, allowed = true } = {}) {
  const sponsorSigner = buildBasicAccountSigner(randomBytes(32).toString('hex'));
  const c = {
    async getAccountInfo() { return { accountNonce: SequenceNumber.create(7), accountAvailableBalance: CcdAmount.fromMicroCcd(sponsorMicro), accountAmount: CcdAmount.fromMicroCcd(0n) }; },
    async invokeContract() { return invokeOk ? { tag: 'success', usedEnergy: Energy.create(2000n) } : { tag: 'failure', reason: { rejectReason: -32 } }; },
  };
  return createRelayer({ grpc: async () => c, sponsor: async () => ({ address: SPONSOR, signer: sponsorSigner }), hitWindow: async () => ({ allowed }), moduleSchemaBase64: async () => 'c2NoZW1h', now: () => Date.now() });
}
test('relay prepare: sponsor signs first; a 0-CCD sender only adds its signature', async () => {
  const r = await fakeRelayer().prepare({ sender: FRAUD, entrypoint: 'accept_payee', parameter: serAcceptPayee({ seller: SELLER, version: 1, proof_anchor: 'ab'.repeat(32) }).toString('hex') });
  assert.equal(r.mode, 'sponsor-first'); assert.equal(r.schema, 'c2NoZW1h');
  const tx = Transaction.signableFromJSON(r.transaction);
  assert.ok(Object.keys(tx.signatures.sponsor ?? {}).length === 1, 'sponsor signature present');
  assert.equal(Object.keys(tx.signatures.sender ?? {}).length, 0, 'no sender signature yet');
  assert.equal(String(tx.header.nonce.value ?? tx.header.nonce), '7');
  const wallet = buildBasicAccountSigner(randomBytes(32).toString('hex'));
  const fin = Transaction.finalize(await Transaction.sign(tx, wallet));
  assert.equal(Buffer.from(Transaction.getAccountTransactionHash(fin)).length, 32);
});
test('relay prepare: refuses calls the contract would reject, non-whitelisted entrypoints, low float, rate limit', async () => {
  const p = { sender: FRAUD, entrypoint: 'accept_payee', parameter: '00' };
  await assert.rejects(fakeRelayer({ invokeOk: false }).prepare(p), (e) => e.code === 'would_reject');
  await assert.rejects(fakeRelayer().prepare({ ...p, entrypoint: 'set_config' }), (e) => e.code === 'entrypoint_not_sponsored');
  await assert.rejects(fakeRelayer({ sponsorMicro: 10n }).prepare(p), (e) => e.code === 'sponsor_low');
  await assert.rejects(fakeRelayer({ allowed: false }).prepare(p), (e) => e.code === 'rate_limited');
});
