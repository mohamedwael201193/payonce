// Dashboard routes (dash.mjs) against a fake chain: shapes, idempotency, never resubmitting an unknown-status op.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, DashError, DASH_POLICY } from '../src/dash.mjs';

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const PAYER = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
const ME = '4MDjZpfasyxR8sJDnyXewHU13QzxpNmhn3xUmeBxcui8mUS7Ns';
const OTHER = '3LgPU9K2WFg3ghFHXjm2r2Mizi2eqY71ENTWqHZL98h9ueFKMt';
const PRES = { type: 'VerifiablePresentation', verifiableCredential: [{ issuer: 'did:ccd:testnet:idp:0', credentialSubject: { statement: [] } }] };

function memKv() {
  const m = new Map();
  return {
    m,
    get: async (ns, k) => structuredClone(m.get(`${ns}|${k}`) ?? null),
    put: async (ns, k, v) => { m.set(`${ns}|${k}`, structuredClone(v)); },
    list: async (ns) => [...m.entries()].filter(([k]) => k.startsWith(`${ns}|`)).map(([k, v]) => ({ key: k.slice(ns.length + 1), value: structuredClone(v) })),
  };
}

function fakeChain(opts = {}) {
  let n = 0;
  const sent = []; const signed = [];
  const payees = new Map(); const payables = new Map();
  const outcomes = new Map(); // hash -> {ok, reject}
  const c = {
    sent, signed, payees, payables, outcomes,
    submitError: null, notSentOnce: false, pendingForever: false,
    async sign(role, entrypoint, paramHex, amount, energy) {
      const pre = (++n).toString(16).padStart(64, '0');
      // c.nodeHash: the node's hash differs from the pre-send hash (the real SDK v0 case, tx-hash.mjs); it is the alt candidate
      const hash = c.nodeHash ? `a${pre.slice(1)}` : pre;
      signed.push({ hash, role, entrypoint });
      return {
        hash: pre, alt: c.nodeHash ? [hash] : [], expiry_ms: Date.now() + 300_000,
        submit: async () => {
          if (c.notSentOnce) { c.notSentOnce = false; throw new Error('duplicate nonce'); }
          sent.push({ hash, role, entrypoint, paramHex, amount });
          outcomes.set(hash, (opts.effect ?? defaultEffect)(c, { role, entrypoint, paramHex, amount }));
          if (c.submitError) { const e = c.submitError; c.submitError = null; throw e; }
          return hash;
        },
      };
    },
    async status(hash) { if (c.pendingForever) return { state: 'pending' }; const o = outcomes.get(hash); return o ? { state: 'finalized', ...o } : { state: 'absent' }; },
    async wait(hash) { if (c.pendingForever) return null; return outcomes.get(hash) ?? null; },
    async preview(invoker, entrypoint, paramHex) {
      if (entrypoint === 'register_payable') { const payee = c.lastRegisterPayee?.(paramHex); return payee && !payees.has(payee) ? { ok: false, reject: -28, used: 900n } : { ok: true, reject: null, used: 3000n }; }
      return { ok: true, reject: null, used: 3000n };
    },
    async getPayee(p) { return payees.get(p) ?? null; },
    async getPayable(id) { return payables.get(String(id)) ?? null; },
    async config() { return { cooling_off_secs: 90 }; },
    async balance() { return 10_000_000_000n; },
    notSent: (e) => /duplicate nonce/.test(String(e?.message)),
    findPayTx: async () => 'f'.repeat(64),
  };
  return c;
}
function defaultEffect(c, { entrypoint }) {
  if (entrypoint === 'propose_payee') { c.payees.set(ME, { status: 'Proposed', version: 1, identity: { proof_anchor: c.anchor }, mature_at_ms: null }); return { ok: true, reject: null }; }
  if (entrypoint === 'register_payable') return c.registerOutcome ?? { ok: true, reject: null };
  if (entrypoint === 'pay_ccd') return { ok: true, reject: null };
  if (entrypoint === 'acknowledge_payee') { c.acked = true; return { ok: true, reject: null }; }
  return { ok: true, reject: null };
}

function fakeVop(chain, verdicts = {}) {
  return {
    calls: 0,
    async check({ payee, buyer }) {
      this.calls++;
      const rec = chain.payees.get(payee);
      const verdict = verdicts[payee] ?? (rec ? 'MATCH' : 'UNVERIFIED');
      const mature = rec?.mature_at_ms != null && rec.mature_at_ms <= Date.now();
      return {
        verdict, payable: verdict === 'MATCH' && rec?.status === 'Bound' && mature, reasons: [`${verdict} for ${payee.slice(0, 6)}`], checks: [],
        subject: { book: rec ? { status: rec.status, version: rec.version, mature_at_ms: rec.mature_at_ms } : { status: 'NotBound' } },
        evidence_hash: 'e'.repeat(64), buyer_ack: rec ? { current: !!chain.acked } : null,
        acknowledge: rec ? { parameter: 'ab'.repeat(8) } : null,
      };
    },
  };
}

function setup({ verdicts, policy } = {}) {
  const kv = memKv(); const chain = fakeChain(); const vop = fakeVop(chain, verdicts);
  const hits = new Map();
  const d = createDashboard({
    kv, chain, vop, seller: SELLER, payer: PAYER, agentToken: 1476n, bookLabel: '<13173,0>', book: { index: 13173n, subindex: 0n, name: 'payable_registry_v3' },
    payCcdSchema: 'FAACAAAABgAAAHNlbGxlcgsKAAAAcGF5YWJsZV9pZAU=', sleep: async () => {}, appBase: 'https://app.test',
    hitWindow: async (k, ms, limit) => { const c = (hits.get(k) ?? 0) + 1; hits.set(k, c); return { allowed: c <= limit }; },
    policy: { ...DASH_POLICY, ...policy },
    approvals: { valid: async (id, x) => ({ approval_id: id, approval_hash: 'h'.repeat(64), ...x }) },
  });
  return { d, kv, chain, vop };
}
async function withProof(kv, chain) {
  await kv.put('payee_proof', ME, { account: ME, kind: 'person', name: 'Ada Lovelace', attributes: { nationality: 'DK' }, version: 'v1', vaa_tx: 'a'.repeat(64) });
  await kv.put('payee_proof_presentation', ME, { version: 'v1', presentation: PRES });
  const { presentationAnchor } = await import('../src/vop.mjs');
  chain.anchor = presentationAnchor(PRES);
}
const until = async (fn, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 2)); } throw new Error('timeout'); };

test('propose: needs a stored name proof; sends propose_payee once; a repeat sends nothing', async () => {
  const { d, kv, chain } = setup();
  await assert.rejects(d.propose({ account: ME }, 'ip'), (e) => e instanceof DashError && e.code === 'no_name_proof');
  await withProof(kv, chain);
  const r = await d.propose({ account: ME }, 'ip');
  assert.equal(r.seller, SELLER); assert.equal(r.version, 1); assert.equal(r.proof_anchor, chain.anchor); assert.match(r.tx_hash, /^[0-9a-f]{64}$/); assert.equal(r.status, 'Proposed');
  assert.equal(chain.sent.length, 1);
  const again = await d.propose({ account: ME }, 'ip');
  assert.equal(again.tx_hash, r.tx_hash); assert.equal(chain.sent.length, 1);
  assert.ok(await kv.get('vop_proof', chain.anchor), 'the proof is stored under the anchor check_payee re-verifies');
  await assert.rejects(d.propose({ account: SELLER }, 'ip'), (e) => e.code === 'reserved_account');
  await assert.rejects(d.propose({ account: 'nope' }, 'ip'), (e) => e.code === 'bad_account');
});

test('op ledger: unknown submit result is never resent; a later call looks the hash up', async () => {
  const { d, chain, kv } = setup();
  chain.submitError = new Error('socket hang up');
  const r = await d._op('k1', 'seller', () => chain.sign('seller', 'propose_payee', '00', 0n, 4000n));
  assert.equal(chain.sent.length, 1); assert.equal(chain.signed.length, 1); assert.equal(r.ok, true);
  const r2 = await d._op('k1', 'seller', () => chain.sign('seller', 'propose_payee', '00', 0n, 4000n));
  assert.equal(r2.hash, r.hash); assert.equal(chain.signed.length, 1);
  // pending: reported, not resent
  chain.pendingForever = true;
  await kv.put('dash_op', 'k2', { state: 'sent', hash: '9'.repeat(64), expiry_ms: Date.now() + 1000 });
  await assert.rejects(d._op('k2', 'seller', () => chain.sign('seller', 'x', '00', 0n, 4000n)), (e) => e.code === 'op_pending' && e.extra.tx_hash === '9'.repeat(64));
  assert.equal(chain.signed.length, 1);
});

test('op ledger: the node-returned hash wins; with an unknown send every stored candidate is looked up', async () => {
  const { d, chain, kv } = setup();
  chain.nodeHash = true;
  const r = await d._op('h1', 'seller', () => chain.sign('seller', 'propose_payee', '00', 0n, 4000n));
  assert.equal(r.hash, chain.sent[0].hash); assert.match(r.hash, /^a/); assert.equal(r.ok, true);
  chain.submitError = new Error('socket hang up');
  await d._op('h2', 'seller', () => chain.sign('seller', 'propose_payee', '00', 0n, 4000n)).catch(() => {});
  const st = await kv.get('dash_op', 'h2');
  await kv.put('dash_op', 'h2', { ...st, state: 'sent' });
  const r2 = await d._op('h2', 'seller', () => chain.sign('seller', 'propose_payee', '00', 0n, 4000n));
  assert.equal(r2.hash, chain.sent[1].hash, 'found under the alt candidate'); assert.equal(chain.signed.length, 2, 'never re-signed');
});

test('tx-hash: candidates are the block-item hash and the sdk hash; the node answer is normalised', async () => {
  const { hashCandidates, returnedHash } = await import('../src/tx-hash.mjs');
  const { Transaction, AccountAddress, CcdAmount, TransactionExpiry, SequenceNumber, buildBasicAccountSigner } = await import('@concordium/web-sdk');
  const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: AccountAddress.fromBase58(PAYER) })
    .addMetadata({ sender: AccountAddress.fromBase58(SELLER), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) }).build();
  const fin = await Transaction.signAndFinalize(tx, buildBasicAccountSigner('1'.repeat(64)));
  const c = hashCandidates(fin);
  assert.equal(c.length, 2); c.forEach((h) => assert.match(h, /^[0-9a-f]{64}$/));
  assert.equal(returnedHash('AB'.repeat(32)), 'ab'.repeat(32)); assert.equal(returnedHash({ toString: () => 'c'.repeat(64) }), 'c'.repeat(64));
});

test('op ledger: a node refusal before acceptance (duplicate nonce) is re-signed once', async () => {
  const { d, chain } = setup();
  chain.notSentOnce = true;
  const r = await d._op('k3', 'payer', () => chain.sign('payer', 'pay_ccd', '00', 1n, 6000n));
  assert.equal(chain.signed.length, 2); assert.equal(chain.sent.length, 1); assert.equal(r.hash, chain.sent[0].hash);
});

test('payee status: NotBound / Bound with hold end and link', async () => {
  const { d, chain } = setup();
  let s = await d.payeeStatus(ME);
  assert.deepEqual([s.status, s.version, s.hold_secs, s.hold_ends_at, s.link], ['NotBound', 0, 90, null, `https://app.test/p/${ME}`]);
  const t = Date.now() + 60_000;
  chain.payees.set(ME, { status: 'Bound', version: 2, identity: { proof_anchor: 'c'.repeat(64) }, mature_at_ms: t });
  s = await d.payeeStatus(ME);
  assert.equal(s.status, 'Bound'); assert.equal(s.version, 2); assert.equal(s.hold_ends_at, new Date(t).toISOString());
  assert.equal(s.tx_hash, null);
});

test('payee status includes the accept_payee hash when findBindTx can see it', async () => {
  const HASH = 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701';
  const kv = memKv(); const chain = fakeChain(); const vop = fakeVop(chain);
  const d = createDashboard({
    kv, chain, vop, seller: SELLER, payer: PAYER, agentToken: 1476n, bookLabel: '<13173,0>', book: { index: 13173n, subindex: 0n, name: 'payable_registry_v3' },
    payCcdSchema: 'FAACAAAABgAAAHNlbGxlcgsKAAAAcGF5YWJsZV9pZAU=', sleep: async () => {}, appBase: 'https://app.test',
    hitWindow: async () => ({ allowed: true }),
    findBindTx: async (account, book) => { assert.equal(account, ME); assert.equal(bookAsOrLabel(book), '<13173,0>'); return HASH; },
  });
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: 'c'.repeat(64) }, mature_at_ms: Date.now() - 1 });
  const s = await d.payeeStatus(ME);
  assert.equal(s.tx_hash, HASH);
});
function bookAsOrLabel(book) {
  if (typeof book === 'string') return book;
  return `<${book.index},${book.subindex ?? 0}>`;
}


test('getpaid: not bound -> 409; bound -> hold -> ack -> register -> pay -> paid, recorded as received', async () => {
  const { d, chain, kv } = setup();
  await withProof(kv, chain);
  await assert.rejects(d.startGetPaid({ payee: ME, invoice: null }, 'ip'), (e) => e.code === 'not_bound');
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: chain.anchor }, mature_at_ms: Date.now() - 1 });
  const { job_id } = await d.startGetPaid({ payee: ME, invoice: { payee_name: 'Ada Lovelace', account: ME, amount_ccd: '1', reference: 'INV-1' } }, 'ip');
  assert.match(job_id, /^[0-9a-f]{24}$/);
  const again = await d.startGetPaid({ payee: ME, invoice: null }, 'ip');
  const j = await until(async () => { const x = await d.getJob(job_id); return ['paid', 'failed', 'refused'].includes(x.stage) && x; });
  assert.equal(j.stage, 'paid', j.error); assert.match(j.pay_tx, /^[0-9a-f]{64}$/);
  assert.equal(j.amount_display, '1 CCD'); assert.equal(j.payer_label, 'reference payer run by PayOnce');
  assert.deepEqual(chain.sent.map((s) => s.entrypoint), ['acknowledge_payee', 'register_payable', 'pay_ccd']);
  assert.ok(again.job_id === job_id || again.job_id, 'a second start while running returns a job id');
  const rec = await d.record(ME);
  assert.equal(rec.items[0].role, 'received'); assert.equal(rec.items[0].tx_hash, j.pay_tx);
});

test('getpaid: a verdict other than Match is refused with no transaction', async () => {
  const { d, chain, kv } = setup({ verdicts: { [ME]: 'NO_MATCH' } });
  await withProof(kv, chain);
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: chain.anchor }, mature_at_ms: Date.now() - 1 });
  const { job_id } = await d.startGetPaid({ payee: ME, invoice: { payee_name: 'Someone Else', account: ME, amount_ccd: '1', reference: null } }, 'ip');
  const j = await until(async () => { const x = await d.getJob(job_id); return x.stage !== 'checking' && x; });
  assert.equal(j.stage, 'refused'); assert.equal(chain.sent.length, 0);
});

test('getpaid: an invoice naming another account is refused up front', async () => {
  const { d, chain, kv } = setup();
  await withProof(kv, chain);
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: chain.anchor }, mature_at_ms: Date.now() - 1 });
  await assert.rejects(d.startGetPaid({ payee: ME, invoice: { payee_name: 'Ada', account: OTHER, amount_ccd: '1', reference: null } }, 'ip'), (e) => e.code === 'invoice_account_mismatch');
});

test('redirect: unbound account -> check + forced attempt refused on chain (-28); idempotent; one per job', async () => {
  const { d, chain, kv } = setup();
  await withProof(kv, chain);
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: chain.anchor }, mature_at_ms: Date.now() - 1 });
  const { job_id } = await d.startGetPaid({ payee: ME, invoice: null }, 'ip');
  await until(async () => (await d.getJob(job_id)).stage === 'paid');
  chain.lastRegisterPayee = () => OTHER; chain.registerOutcome = { ok: false, reject: -28 };
  const r = await d.redirect(job_id, { to: OTHER }, 'ip');
  assert.equal(r.check.verdict, 'UNVERIFIED'); assert.deepEqual(r.refusal, { code: -28, name: 'PayeeNotBound', tx_hash: chain.sent.at(-1).hash });
  const n = chain.sent.length;
  assert.deepEqual(await d.redirect(job_id, { to: OTHER }, 'ip'), r); assert.equal(chain.sent.length, n);
  await assert.rejects(d.redirect(job_id, { to: SELLER }, 'ip'), (e) => e.code === 'already_redirected');
  await assert.rejects(d.redirect(job_id, { to: ME }, 'ip'), (e) => e.code === 'same_account' || e.code === 'already_redirected');
  assert.equal((await d.record(ME)).items.find((i) => i.role === 'refused').tx_hash, r.refusal.tx_hash);
});

test('pay-tx: refuses unless payable; registers the invoice once and reuses it; returns the wallet UpdateTx', async () => {
  const { d, chain, kv } = setup();
  await assert.rejects(d.payTx(ME, { payer: OTHER, amount_micro: '1000000' }, 'ip'), (e) => e.code === 'not_payable');
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: 'c'.repeat(64) }, mature_at_ms: Date.now() - 1 });
  await assert.rejects(d.payTx(ME, { payer: OTHER, amount_micro: '99999999' }, 'ip'), (e) => e.code === 'bad_amount');
  const t = await d.payTx(ME, { payer: OTHER, amount_micro: '1000000', name: 'Ada Lovelace' }, 'ip');
  assert.equal(t.transaction.receive_name, 'payable_registry_v3.pay_ccd'); assert.deepEqual(t.transaction.contract, { index: 13173, subindex: 0 });
  assert.equal(t.transaction.amount_micro, '1000000'); assert.equal(t.transaction.parameter_json.seller, SELLER); assert.equal(t.transaction.schema.type, 'parameter');
  assert.ok(t.acknowledge && t.acknowledge.entrypoint === 'acknowledge_payee', 'no ack yet -> acknowledge step returned');
  chain.payables.set(String(t.invoice.payable_id), { status: { tag: 'Unpaid' }, due_ms: Date.now() + 86_400_000 });
  const t2 = await d.payTx(ME, { payer: OTHER, amount_micro: '1000000' }, 'ip');
  assert.equal(t2.invoice.payable_id, t.invoice.payable_id); assert.equal(chain.sent.filter((s) => s.entrypoint === 'register_payable').length, 1);
  chain.payables.set(String(t.invoice.payable_id), { status: { tag: 'Paid', paid_at_ms: Date.now(), tx_hash: null }, due_ms: Date.now() + 86_400_000 });
  const rec = await d.record(OTHER);
  assert.equal(rec.items[0].role, 'paid'); assert.equal(rec.items[0].counterparty, ME); assert.equal(rec.items[0].tx_hash, 'f'.repeat(64));
});


test('pay-tx EUDemo: registers an EUDemo payable and returns reserve + transfer + replay, not pay_ccd', async () => {
  const { d, chain } = setup();
  chain.payees.set(ME, { status: 'Bound', version: 1, identity: { proof_anchor: 'c'.repeat(64) }, mature_at_ms: Date.now() - 1 });
  await assert.rejects(d.payTx(ME, { payer: OTHER, amount_micro: '1000000', asset: 'eudemo' }, 'ip'), (e) => e.code === 'bad_amount');
  const t = await d.payTx(ME, { payer: OTHER, amount_micro: '10000', asset: 'eudemo', name: 'Ada Lovelace' }, 'ip');
  assert.equal(t.rail, 'eudemo');
  assert.equal(t.transaction, undefined);
  assert.equal(t.invoice.asset, 'EUDemo');
  assert.equal(t.invoice.amount_micro, '10000');
  assert.equal(t.reserve.entrypoint, 'reserve_plt');
  assert.match(t.reserve.parameter, /^[0-9a-f]+$/i);
  assert.equal(t.transfer.kind, 'token');
  assert.equal(t.transfer.token, 'EUDemo');
  assert.equal(t.transfer.recipient, ME);
  assert.equal(t.transfer.amount, '10000');
  assert.equal(t.transfer.memo, `payable:${SELLER}:${t.invoice.payable_id}`);
  assert.equal(t.replay.expect_reject, -16);
  assert.equal(chain.sent.filter((s) => s.entrypoint === 'register_payable').length, 1);
  chain.payables.set(String(t.invoice.payable_id), { status: { tag: 'Unpaid' }, due_ms: Date.now() + 86_400_000 });
  const t2 = await d.payTx(ME, { payer: OTHER, amount_micro: '10000', rail: 'eudemo' }, 'ip');
  assert.equal(t2.invoice.payable_id, t.invoice.payable_id);
  assert.equal(chain.sent.filter((s) => s.entrypoint === 'register_payable').length, 1);
  // CCD and EUDemo links do not collide
  const ccd = await d.payTx(ME, { payer: OTHER, amount_micro: '1000000' }, 'ip');
  assert.equal(ccd.rail, 'ccd');
  assert.ok(ccd.transaction.receive_name.endsWith('.pay_ccd'));
  assert.notEqual(ccd.invoice.payable_id, t.invoice.payable_id);
  const hash = '7ddeb8280c8e85dd42c2c691d1b308117d09cf0534cee7c02b18abb65a60eb8b';
  const conf = await d.pltConfirm(ME, { payable_id: t.invoice.payable_id, tx_hash: hash });
  assert.equal(conf.entrypoint, 'confirm_plt');
  assert.match(conf.parameter, /^[0-9a-f]+$/i);
  await assert.rejects(d.pltConfirm(ME, { payable_id: t.invoice.payable_id, tx_hash: 'nope' }), (e) => e.code === 'bad_hash');
  await assert.rejects(d.pltConfirm(OTHER, { payable_id: t.invoice.payable_id, tx_hash: hash }), (e) => e.code === 'no_paylink');
});

test('getJob: a run interrupted by a restart is reported failed, nothing resent', async () => {
  const { d, kv, chain } = setup();
  await kv.put('dash_job', 'a'.repeat(24), { job_id: 'a'.repeat(24), payee: ME, name: 'Ada', amount_micro: '1000000', stage: 'paying', register_tx: 'b'.repeat(64), updated_at: new Date(Date.now() - 600_000).toISOString() });
  const j = await d.getJob('a'.repeat(24));
  assert.equal(j.stage, 'failed'); assert.match(j.error, /interrupted/); assert.equal(j.txs.register, 'b'.repeat(64)); assert.equal(chain.sent.length, 0);
  await assert.rejects(d.getJob('zz'), (e) => e.code === 'bad_job');
});

test('rate limits: proposals per IP per hour', async () => {
  const { d, kv, chain } = setup({ policy: { proposePerIpPerHour: 1 } });
  await withProof(kv, chain);
  await d.propose({ account: ME }, 'ip9');
  await assert.rejects(d.propose({ account: ME }, 'ip9'), (e) => e.code === 'rate_limited');
});

test('pay-tx approval rules: No match never; Close match only with approved=1; Not possible never', async () => {
  const { d, chain } = setup({ verdicts: { [ME]: 'CLOSE_MATCH', [OTHER]: 'NO_MATCH', [SELLER]: 'UNVERIFIED' } });
  for (const a of [ME, OTHER, SELLER]) chain.payees.set(a, { status: 'Bound', version: 1, identity: { proof_anchor: 'c'.repeat(64) }, mature_at_ms: Date.now() - 1 });
  await assert.rejects(d.payTx(ME, { payer: PAYER, amount_micro: '1000' }, 'ip'), (e) => e.code === 'needs_signed_approval');
  await assert.rejects(d.payTx(ME, { payer: PAYER, amount_micro: '1000', approved: '1' }, 'ip'), (e) => e.code === 'needs_signed_approval', 'a click is not enough');
  const ok = await d.payTx(ME, { payer: PAYER, amount_micro: '1000', approval: 'a'.repeat(24) }, 'ip');
  assert.equal(ok.approval.approval_id, 'a'.repeat(24));
  assert.equal(ok.check.verdict, 'CLOSE_MATCH'); assert.equal(ok.transaction.amount_micro, '1000');
  await assert.rejects(d.payTx(OTHER, { payer: PAYER, amount_micro: '1000', approved: '1' }, 'ip'), (e) => e.code === 'not_payable');
  await assert.rejects(d.payTx(SELLER, { payer: PAYER, amount_micro: '1000', approved: '1' }, 'ip'), (e) => e.code === 'not_payable' && /-36/.test(e.message));
});
