// PayOnce /app dashboard (R0-R5) on the v3 DEMO book (90 s cooling-off). Testnet only.
//
//   propose(body)          POST /api/payee/propose        demo seller proposes the visitor (bound to their stored name proof)
//   payeeStatus(account)   GET  /api/payee/:account       the visitor's payee-book state + hold
//   startGetPaid(body)     POST /api/getpaid              the reference payer agent: check_payee -> hold -> ack -> invoice -> pay
//   getJob(id)             GET  /api/getpaid/:job
//   redirect(id, body)     POST /api/getpaid/:job/redirect the agent is told to pay another account: check + forced attempt
//   payTx(payee, q)        GET  /api/p/:account/pay-tx    the exact pay transaction the visitor's wallet signs
//   record(account)        GET  /api/record/:account
//
// Every server-signed transaction goes through op(): its hash is computed and stored BEFORE it is sent, it is sent
// once, and a later call with the same key looks the hash up on chain instead of sending again. A send is repeated
// only when the node refused it before acceptance (duplicate nonce) or its hash is absent after expiry.
import { randomBytes } from 'node:crypto';
import { V3_ERRORS, serProposePayee, serRegisterPayable, serPayableKey, serConfirmPlt } from './vop-chain.mjs';
import { legalNameHash, presentationAnchor, sha256Hex } from './vop.mjs';
import { factsFromPresentation } from './vop-service.mjs';

export const DASH_POLICY = Object.freeze({
  proposePerIpPerHour: 6, proposePerAccountPerDay: 4, proposePerDay: 150,
  getpaidPerIpPerHour: 4, getpaidPerPayeePerDay: 3, getpaidPerDay: 60,
  redirectPerIpPerHour: 6, redirectPerDay: 60,
  payTxPerIpPerHour: 6, payTxPerPayerPerDay: 5, payTxPerDay: 60,
  getpaidMicro: 1_000_000n, payTxMaxMicro: 5_000_000n, payTxMaxEudemoMicro: 100_000n, payerFloorMicro: 100_000_000n,
  waitMs: 90_000, staleJobMs: 180_000, maxHoldMs: 30 * 60_000, payEnergy: 6000n, refusedEnergy: 6000n,
});
export const PAYER_LABEL = 'reference payer run by PayOnce';
export const ERR_NAMES = { '-5': 'WrongStatus', ...V3_ERRORS };
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const HOUR = 3_600_000; const DAY = 86_400_000;
const TERMINAL = new Set(['paid', 'refused', 'failed']);

export class DashError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const microToDisplay = (m, unit = 'CCD') => {
  const v = BigInt(m); const whole = v / 1_000_000n; const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ${unit}`;
};
const randomPayableId = () => 1_000_000_000 + Number(BigInt(`0x${randomBytes(5).toString('hex')}`)); // < 2^41, unique per call

/**
 * deps: {
 *   kv: { get(ns,k), put(ns,k,v), list(ns) -> [{key,value}] }, hitWindow(key, ms, limit) -> {allowed},
 *   vop: createVopService({ book: demo }), seller, payer, agentToken, appBase, bookLabel, book: {index, subindex, name},
 *   payCcdSchema (base64), now(), sleep(ms),
 *   chain: {
 *     sign(role:'seller'|'payer', entrypoint, paramHex, amountMicro:bigint, energy:bigint) -> { hash, expiry_ms, submit() },
 *     status(hash) -> { state: 'finalized', ok, reject } | { state: 'pending' } | { state: 'absent' },
 *     wait(hash, ms) -> { ok, reject } | null,
 *     preview(invoker, entrypoint, paramHex, amountMicro) -> { ok, reject, used },
 *     getPayee(payee) -> record|null, getPayable(id) -> payable|null, config() -> { cooling_off_secs },
 *     balance(address) -> bigint micro, notSent(error) -> true when the node refused before acceptance,
 *     findPayTx?(payer, paidAtMs) -> hash|null
 *   }
 * }
 */
export function createDashboard(deps) {
  const { kv, chain, vop, seller, payer, agentToken, now = Date.now, policy = DASH_POLICY } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const appBase = deps.appBase ?? 'https://payonce-tau.vercel.app';
  const running = new Map();
  const locks = new Map();
  const iso = (ms) => new Date(ms).toISOString();

  function addr(a, what = 'account') {
    const s = String(a ?? '').trim();
    if (!ADDR.test(s)) throw new DashError(400, 'bad_account', `That is not a Concordium ${what} address.`);
    return s;
  }
  async function budget(key, windowMs, limit, msg) {
    const r = await deps.hitWindow(key, windowMs, limit);
    if (r && r.allowed === false) throw new DashError(429, 'rate_limited', msg);
  }
  function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    locks.set(key, p.catch(() => {}));
    return p;
  }

  // ---------------- op ledger ----------------
  async function settle(key, prev, hash) {
    const r = await chain.wait(hash, policy.waitMs);
    if (!r) throw new DashError(409, 'op_pending', `Transaction ${hash} is not finalized yet; it will not be sent again. Try again shortly.`, { tx_hash: hash });
    const done = { ...prev, state: 'final', hash, ok: r.ok, reject: r.reject ?? null, final_at: iso(now()) };
    await kv.put('dash_op', key, done);
    return done;
  }
  async function op(key, role, build, onSent) {
    return withLock(`role:${role}`, async () => {
      const prev = await kv.get('dash_op', key);
      if (prev?.state === 'final') return prev;
      if (prev?.hash && prev.state === 'sent') {
        // every candidate hash stored before the send is looked up (tx-hash.mjs)
        let st = { state: 'absent' }; let found = prev.hash;
        for (const h of [prev.hash, ...(prev.alt ?? [])]) { const s = await chain.status(h); if (s.state !== 'absent') { st = s; found = h; break; } }
        const p2 = found === prev.hash ? prev : { ...prev, hash: found, alt: [prev.hash, ...(prev.alt ?? [])].filter((h) => h !== found) };
        if (st.state === 'finalized') { const done = { ...p2, state: 'final', ok: st.ok, reject: st.reject ?? null }; await kv.put('dash_op', key, done); return done; }
        if (st.state === 'pending' || st.state === 'unknown' || now() < Number(prev.expiry_ms ?? 0) + 60_000) { if (p2 !== prev) await kv.put('dash_op', key, p2); if (onSent) await onSent(p2.hash); return settle(key, p2, p2.hash); }
        // absent from the chain after its expiry: it never executed, so a new submission cannot double-execute
      }
      for (let attempt = 0; ; attempt++) {
        const tx = await build();
        let rec = { state: 'sent', hash: tx.hash, alt: tx.alt ?? [], expiry_ms: tx.expiry_ms, role, at: iso(now()) };
        await kv.put('dash_op', key, rec);
        try {
          const got = await tx.submit();
          // the node's own hash wins (the SDK's pre-send hash can differ, see tx-hash.mjs)
          if (typeof got === 'string' && /^[0-9a-f]{64}$/.test(got) && got !== rec.hash) {
            rec = { ...rec, hash: got, alt: [rec.hash, ...rec.alt].filter((h) => h !== got) };
            await kv.put('dash_op', key, rec);
          }
        } catch (e) {
          if (chain.notSent(e) && attempt < 2) { await kv.put('dash_op', key, { ...rec, state: 'not_sent', error: String(e?.message ?? e).slice(0, 160) }); continue; }
          // status unknown: never resend; every candidate hash is looked up on every later call
        }
        if (onSent) await onSent(rec.hash);
        return settle(key, rec, rec.hash);
      }
    });
  }
  const energyFor = (pv, floor = 4000n) => { const u = BigInt(pv?.used ?? 0); const e = u + u / 5n + 500n; return e > floor ? e : floor; };

  async function addRecord(account, item) {
    await kv.put('dash_record', `${account}:${item.at}:${randomBytes(3).toString('hex')}`, { account, ...item });
    if (deps.ledger) await deps.ledger.append({ kind: `dash_${item.role}`, book: deps.bookLabel, account, counterparty: item.counterparty, amount: item.amount_display, verdict: item.verdict, tx_hash: item.tx_hash ?? null }).catch(() => {});
  }

  // ---------------- R2: become a payee ----------------
  async function propose(body, ip) {
    const account = addr(body?.account);
    if (account === seller || account === payer) throw new DashError(400, 'reserved_account', 'That account runs the demo; connect your own wallet.');
    await budget(`dash:propose:ip:${ip}`, HOUR, policy.proposePerIpPerHour, 'Too many proposals from here; try again later.');
    const proof = await kv.get('payee_proof', account);
    const wp = await kv.get('payee_proof_presentation', account);
    if (!proof?.name || !wp?.presentation) throw new DashError(409, 'no_name_proof', 'Prove your name first: the demo book binds a payee only to a name the wallet proved.');
    const anchor = presentationAnchor(wp.presentation);
    const rec = await chain.getPayee(account);
    if (rec && rec.status !== 'Revoked' && rec.identity?.proof_anchor === anchor) {
      const prev = await kv.get('dash_propose', account);
      return shapeProposed(rec, anchor, prev?.tx_hash ?? null);
    }
    await budget(`dash:propose:acct:${account}`, DAY, policy.proposePerAccountPerDay, 'This account was proposed several times today; try again tomorrow.');
    await budget('dash:propose:day', DAY, policy.proposePerDay, 'The demo book reached its daily number of new payees; try again tomorrow.');
    if (!(await kv.get('vop_proof', anchor))) {
      await kv.put('vop_proof', anchor, { payee: account, version: wp.version ?? proof.version ?? 'v1', presentation: wp.presentation, stored_at: iso(now()), source: 'wallet_name_proof', anchor_tx: proof.vaa_tx ?? null });
    }
    const facts = factsFromPresentation(wp.presentation);
    const country = [proof.attributes?.nationality, proof.attributes?.countryOfResidence, proof.attributes?.registrationCountry].find((x) => /^[A-Z]{2}$/.test(String(x ?? ''))) ?? 'ZZ';
    const identity = {
      kind: proof.kind === 'business' ? 1 : 2, idp_index: facts.idpIndexes[0] ?? 0, legal_name_hash: legalNameHash(proof.name),
      country, proof_anchor: anchor, anchor_tx: /^[0-9a-f]{64}$/.test(String(proof.vaa_tx ?? '')) ? proof.vaa_tx : null,
    };
    const param = serProposePayee({ payee: account, agent_token: agentToken, identity }).toString('hex');
    const pv = await chain.preview(seller, 'propose_payee', param, 0n);
    if (!pv.ok) throw new DashError(409, 'would_reject', `The demo book would refuse this proposal (reject ${pv.reject} ${ERR_NAMES[String(pv.reject)] ?? ''}). Nothing was sent.`, { reject: pv.reject });
    const r = await op(`propose:${account}:${anchor}`, 'seller', () => chain.sign('seller', 'propose_payee', param, 0n, energyFor(pv)));
    if (!r.ok) throw new DashError(502, 'chain_rejected', `The demo book refused the proposal (reject ${r.reject}).`, { tx_hash: r.hash, reject: r.reject });
    const rec2 = await chain.getPayee(account);
    if (!rec2) throw new DashError(502, 'no_record', 'The proposal finalized but the payee book has no record; try again.', { tx_hash: r.hash });
    await kv.put('dash_propose', account, { tx_hash: r.hash, version: rec2.version, anchor, at: iso(now()) });
    return shapeProposed(rec2, anchor, r.hash);
  }
  function shapeProposed(rec, anchor, tx) {
    return { seller, version: rec.version, proof_anchor: anchor, tx_hash: tx, status: rec.status, book: deps.bookLabel, next: rec.status === 'Bound' ? 'already bound: skip accept_payee' : 'sign accept_payee via POST /api/relay/prepare with book:"demo"' };
  }

  async function payeeStatus(account) {
    const a = addr(account);
    const [rec, cfg] = await Promise.all([chain.getPayee(a), chain.config()]);
    const status = !rec || rec.status === 'Revoked' ? 'NotBound' : rec.status;
    let tx_hash = null;
    if (status === 'Bound' && deps.findBindTx) {
      tx_hash = await deps.findBindTx(a, deps.book ?? deps.bookLabel).catch(() => null);
      if (tx_hash && !/^[0-9a-f]{64}$/i.test(tx_hash)) tx_hash = null;
    }
    return {
      account: a, seller, status, version: rec?.version ?? 0, hold_secs: cfg.cooling_off_secs,
      hold_ends_at: status === 'Bound' && rec.mature_at_ms ? iso(rec.mature_at_ms) : null,
      link: `${appBase}/p/${a}`, book: deps.bookLabel, proof_anchor: rec?.identity?.proof_anchor ?? null,
      tx_hash,
    };
  }

  // ---------------- R3: get paid by the reference payer agent ----------------
  function shapeJob(j) {
    return {
      job_id: j.job_id, stage: j.stage, check: j.check ?? null, hold_ends_at: j.hold_ends_at ?? null, pay_tx: j.pay_tx ?? null,
      amount_display: microToDisplay(j.amount_micro), payer_label: PAYER_LABEL, error: j.error ?? null,
      payee: j.payee, invoice_name: j.name, payer: payer, book: deps.bookLabel, payable_id: j.payable_id ?? null,
      txs: { ack: j.ack_tx ?? null, register: j.register_tx ?? null, pay: j.pay_tx ?? j.pay_tx_pending ?? null }, refusal: j.refusal ?? null,
      redirect: j.redirect ? { to: j.redirect.to, at: j.redirect.at } : null,
    };
  }
  async function save(j, patch) { Object.assign(j, patch, { updated_at: iso(now()) }); await kv.put('dash_job', j.job_id, j); return j; }

  async function startGetPaid(body, ip) {
    const payee = addr(body?.payee, 'payee');
    const inv = body?.invoice ?? null;
    if (inv?.account && String(inv.account).trim() !== payee) {
      throw new DashError(409, 'invoice_account_mismatch', 'The invoice names a different account than the payee asking to be paid. The agent pays nobody.', { invoice_account: inv.account });
    }
    const active = await kv.get('dash_job_active', payee);
    if (active?.job_id) {
      const j = await kv.get('dash_job', active.job_id);
      if (j && !TERMINAL.has(j.stage) && (running.has(j.job_id) || now() - Date.parse(j.updated_at) < policy.staleJobMs)) return { job_id: j.job_id };
    }
    const rec = await chain.getPayee(payee);
    if (!rec || rec.status !== 'Bound') throw new DashError(409, 'not_bound', 'Become a payee first: the demo book has no bound record for this account.');
    await budget(`dash:getpaid:ip:${ip}`, HOUR, policy.getpaidPerIpPerHour, 'Too many payment runs from here; try again later.');
    await budget(`dash:getpaid:payee:${payee}`, DAY, policy.getpaidPerPayeePerDay, 'This payee was paid several times today; try again tomorrow.');
    await budget('dash:getpaid:day', DAY, policy.getpaidPerDay, 'The reference payer reached its daily number of payments; try again tomorrow.');
    if ((await chain.balance(payer)) < policy.payerFloorMicro) throw new DashError(503, 'payer_low', 'The reference payer is low on testnet CCD; payments are paused.');
    const proof = await kv.get('payee_proof', payee);
    const name = String(inv?.payee_name ?? proof?.name ?? '').trim().slice(0, 140);
    if (!name) throw new DashError(400, 'no_name', 'The invoice has no payee name.');
    const j = {
      job_id: randomBytes(12).toString('hex'), payee, name, amount_micro: policy.getpaidMicro.toString(),
      amount_requested: inv?.amount_ccd ?? null, reference: inv?.reference ?? null, stage: 'checking',
      created_at: iso(now()), updated_at: iso(now()),
    };
    await kv.put('dash_job', j.job_id, j);
    await kv.put('dash_job_active', payee, { job_id: j.job_id });
    const p = runJob(j).finally(() => running.delete(j.job_id));
    running.set(j.job_id, p);
    return { job_id: j.job_id };
  }

  async function runJob(j) {
    try {
      let check;
      for (let round = 0; ; round++) {
        if (round > 8) throw new Error('the payee did not become payable');
        check = await vop.check({ seller, payee: j.payee, legal_name: j.name, buyer: payer });
        await save(j, { check, stage: 'checking' });
        if (check.verdict !== 'MATCH') {
          await save(j, { stage: 'refused', error: check.reasons?.[0] ?? `check_payee: ${check.verdict}` });
          await addRecord(j.payee, { at: iso(now()), role: 'refused', counterparty: payer, amount_display: microToDisplay(j.amount_micro), verdict: check.verdict, tx_hash: null, note: 'the payer agent refused before paying' });
          return;
        }
        const matureAt = Number(check.subject?.book?.mature_at_ms ?? 0);
        if (!matureAt) throw new Error('the payee record has no maturity time');
        if (matureAt > now()) {
          if (matureAt - now() > policy.maxHoldMs) throw new Error('the hold ends too far ahead');
          await save(j, { stage: 'hold', hold_ends_at: iso(matureAt) });
          await sleep(Math.min(matureAt - now() + 2_000, policy.maxHoldMs));
          continue;
        }
        if (!check.buyer_ack?.current) {
          const v = check.subject.book.version;
          const r = await op(`ack:${j.payee}:${v}:${check.evidence_hash}`, 'payer', () => chain.sign('payer', 'acknowledge_payee', check.acknowledge.parameter, 0n, 8000n), (h) => save(j, { ack_tx: h }));
          await save(j, { ack_tx: r.hash });
          if (!r.ok) throw new Error(`acknowledge_payee was refused (reject ${r.reject}, ${r.hash})`);
          continue;
        }
        if (!check.payable) {
          await save(j, { stage: 'refused', error: check.reasons?.[0] ?? 'check_payee: not payable' });
          return;
        }
        break;
      }
      if (j.payable_id == null) await save(j, { payable_id: randomPayableId() });
      const due = now() + DAY;
      const reg = serRegisterPayable({
        payable_id: j.payable_id, payee: j.payee, amount: BigInt(j.amount_micro), asset: 'CCD', due_ms: due,
        doc_hash: sha256Hex(`payonce dashboard invoice ${j.job_id} ${j.name} ${j.reference ?? ''}`), agent_token: agentToken, expected_payer: payer, legal_ref: null,
      }).toString('hex');
      const r1 = await op(`register:${j.job_id}`, 'seller', () => chain.sign('seller', 'register_payable', reg, 0n, 12000n), (h) => save(j, { register_tx: h }));
      await save(j, { register_tx: r1.hash, stage: 'paying' });
      if (!r1.ok) throw new Error(`register_payable was refused (reject ${r1.reject}, ${r1.hash})`);
      const key = serPayableKey({ seller, payable_id: j.payable_id }).toString('hex');
      const r2 = await op(`pay:${j.job_id}`, 'payer', () => chain.sign('payer', 'pay_ccd', key, BigInt(j.amount_micro), policy.payEnergy + 6000n), (h) => save(j, { pay_tx_pending: h }));
      if (r2.ok) {
        await save(j, { stage: 'paid', pay_tx: r2.hash });
        await addRecord(j.payee, { at: iso(now()), role: 'received', counterparty: payer, amount_display: microToDisplay(j.amount_micro), verdict: 'MATCH', tx_hash: r2.hash });
      } else {
        const refusal = { code: r2.reject, name: ERR_NAMES[String(r2.reject)] ?? 'Rejected', tx_hash: r2.hash };
        await save(j, { stage: 'refused', refusal, error: `The chain refused the payment (${refusal.name}).` });
        await addRecord(j.payee, { at: iso(now()), role: 'refused', counterparty: payer, amount_display: microToDisplay(j.amount_micro), verdict: check.verdict, tx_hash: r2.hash });
      }
    } catch (e) {
      const pending = e instanceof DashError && e.code === 'op_pending';
      await save(j, { stage: 'failed', error: pending ? `${e.message}` : String(e?.message ?? e).slice(0, 300) }).catch(() => {});
    } finally {
      const a = await kv.get('dash_job_active', j.payee).catch(() => null);
      if (a?.job_id === j.job_id) await kv.put('dash_job_active', j.payee, { job_id: null }).catch(() => {});
    }
  }

  async function loadJob(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id))) throw new DashError(400, 'bad_job', 'Unknown job id.');
    const j = await kv.get('dash_job', id);
    if (!j) throw new DashError(404, 'not_found', 'No such job.');
    return j;
  }
  async function getJob(id) {
    const j = await loadJob(id);
    if (!TERMINAL.has(j.stage) && !running.has(j.job_id) && now() - Date.parse(j.updated_at) > policy.staleJobMs && !(j.stage === 'hold' && Date.parse(j.hold_ends_at) > now())) {
      await save(j, { stage: 'failed', error: 'The run was interrupted (server restart). Transactions already sent are listed; none is sent again.' });
    }
    return shapeJob(j);
  }

  // ---------------- R3b: the agent is told to pay another account ----------------
  async function redirect(id, body, ip) {
    const j = await loadJob(id);
    const to = addr(body?.to, 'redirect');
    if (to === j.payee) throw new DashError(400, 'same_account', 'That is the payee itself, not another account.');
    if (j.redirect) {
      if (j.redirect.to === to) return j.redirect.result;
      throw new DashError(409, 'already_redirected', 'This run was already redirected once; start a new run.', { result: j.redirect.result });
    }
    await budget(`dash:redirect:ip:${ip}`, HOUR, policy.redirectPerIpPerHour, 'Too many redirect tries from here; try again later.');
    await budget('dash:redirect:day', DAY, policy.redirectPerDay, 'Daily limit for redirect tries reached; try again tomorrow.');
    const check = await vop.check({ seller, payee: to, legal_name: j.name, buyer: payer });
    let refusal = null;
    let note;
    if (check.payable) {
      note = 'check_payee would allow this account, but the agent pays only the account on the invoice; it pays nothing.';
    } else {
      // Forced: even if the agent ignored check_payee, the book will not put this account on an invoice.
      const pid = randomPayableId();
      const reg = serRegisterPayable({
        payable_id: pid, payee: to, amount: BigInt(j.amount_micro), asset: 'CCD', due_ms: now() + DAY,
        doc_hash: sha256Hex(`payonce dashboard redirect ${j.job_id} ${to}`), agent_token: agentToken, expected_payer: payer, legal_ref: null,
      }).toString('hex');
      const pv = await chain.preview(seller, 'register_payable', reg, 0n);
      if (!pv.ok && Number(pv.reject) <= -28 && Number(pv.reject) >= -36) {
        const r = await op(`redirect:${j.job_id}`, 'seller', () => chain.sign('seller', 'register_payable', reg, 0n, policy.refusedEnergy));
        if (!r.ok && r.reject != null) refusal = { code: r.reject, name: ERR_NAMES[String(r.reject)] ?? 'Rejected', tx_hash: r.hash };
        note = refusal ? `Forced anyway, the chain refused: ${refusal.name} (${refusal.code}).` : 'Forced attempt did not produce a refusal.';
      } else {
        note = pv.ok ? 'This account is bound in the book, so only check_payee stops the agent here; nothing was sent.' : `The book would refuse (reject ${pv.reject}); nothing was sent.`;
      }
    }
    const result = { check, refusal, note, to };
    await save(j, { redirect: { to, at: iso(now()), result } });
    await addRecord(j.payee, { at: iso(now()), role: 'refused', counterparty: to, amount_display: microToDisplay(j.amount_micro), verdict: check.verdict, tx_hash: refusal?.tx_hash ?? null, note: 'redirect refused' });
    return result;
  }

  // ---------------- R4: you pay someone (your wallet signs) ----------------
  async function payTx(payeeIn, q, ip) {
    const payee = addr(payeeIn, 'payee');
    const payerAcct = addr(q?.payer, 'payer');
    if (payee === payerAcct) throw new DashError(400, 'self_payment', 'You cannot pay yourself.');
    const rail = String(q?.asset ?? q?.rail ?? 'ccd').toLowerCase() === 'eudemo' ? 'eudemo' : 'ccd';
    const asset = rail === 'eudemo' ? 'EUDemo' : 'CCD';
    const maxMicro = rail === 'eudemo' ? policy.payTxMaxEudemoMicro : policy.payTxMaxMicro;
    if (!/^\d{1,13}$/.test(String(q?.amount_micro ?? ''))) throw new DashError(400, 'bad_amount', `amount_micro is a whole number of micro ${asset} (6 decimals).`);
    const amount = BigInt(q.amount_micro);
    if (amount < 1n || amount > maxMicro) throw new DashError(400, 'bad_amount', `Demo payments are 1 micro ${asset} to ${microToDisplay(maxMicro, asset)}.`);
    const proof = await kv.get('payee_proof', payee);
    const name = String(q?.name ?? q?.legal_name ?? '').trim() || null;
    const check = await vop.check({ seller, payee, legal_name: name ?? proof?.name ?? '', buyer: payerAcct });
    // MATCH + payable: pay. NO_MATCH: never. CLOSE_MATCH: only when the person approved (approved=1) and the book
    // allows it (Bound, hold over); the contract's acknowledge_payee accepts Close match. UNVERIFIED cannot be
    // acknowledged on chain (the contract refuses -36), so even an approved payment would be refused: nothing to sign.
    // A Close match needs the person's wallet-signed approval (approvals.mjs, G11), not a click.
    let approval = null;
    if (check.verdict === 'CLOSE_MATCH' && q?.approval) {
      if (!deps.approvals) throw new DashError(503, 'approvals_unavailable', 'Signed approvals are not available on this server.');
      approval = await deps.approvals.valid(String(q.approval), { payer: payerAcct, payee, amount_micro: amount.toString() });
    }
    const approved = !!approval;
    const bk = check.subject?.book ?? {};
    const bookOk = bk.status === 'Bound' && Number(bk.mature_at_ms ?? Infinity) <= now();
    if (check.verdict === 'NO_MATCH') throw new DashError(409, 'not_payable', check.reasons?.[0] ?? 'No match: nothing to sign.', { check });
    if (check.verdict === 'UNVERIFIED') throw new DashError(409, 'not_payable', 'Verification not possible: the book cannot record an acknowledgment for this payee, so the chain would refuse the payment (-36). Nothing to sign.', { check });
    if (check.verdict === 'CLOSE_MATCH' && !approved) throw new DashError(409, 'needs_signed_approval', 'Close match: the payer must sign an approval with the wallet first (POST /api/approvals/request, then /api/approvals/:id/verify), then pass approval=<id>.', { check });
    if (!(check.payable || (check.verdict === 'CLOSE_MATCH' && approved && bookOk))) throw new DashError(409, 'not_payable', check.reasons?.[0] ?? `check_payee: ${check.verdict}; nothing to sign.`, { check });
    const key = `${payee}:${payerAcct}:${amount}:${rail}`;
    let link = await kv.get('dash_paylink', key);
    if (link?.payable_id != null) {
      const p = await chain.getPayable(link.payable_id);
      if (!p || p.status?.tag !== 'Unpaid' || p.due_ms < now() + 10 * 60_000) link = null;
    }
    if (!link) {
      await budget(`dash:paytx:ip:${ip}`, HOUR, policy.payTxPerIpPerHour, 'Too many payment links from here; try again later.');
      await budget(`dash:paytx:payer:${payerAcct}`, DAY, policy.payTxPerPayerPerDay, 'This wallet made several payment links today; try again tomorrow.');
      await budget('dash:paytx:day', DAY, policy.payTxPerDay, 'Daily limit for payment links reached; try again tomorrow.');
      const pid = randomPayableId();
      const reg = serRegisterPayable({
        payable_id: pid, payee, amount, asset, due_ms: now() + DAY,
        doc_hash: sha256Hex(`payonce dashboard pay link ${payee} ${payerAcct} ${amount} ${asset} ${pid}`), agent_token: agentToken, expected_payer: payerAcct, legal_ref: null,
      }).toString('hex');
      const r = await op(`paylink:${key}:${pid}`, 'seller', () => chain.sign('seller', 'register_payable', reg, 0n, 12000n));
      if (!r.ok) throw new DashError(502, 'chain_rejected', `The book refused the invoice for this payment (reject ${r.reject}).`, { tx_hash: r.hash, reject: r.reject });
      link = { payable_id: pid, register_tx: r.hash, payee, payer: payerAcct, amount_micro: amount.toString(), asset, verdict: check.verdict, at: iso(now()) };
      await kv.put('dash_paylink', key, link);
      await kv.put('dash_paylink_by_payer', `${payerAcct}:${pid}`, link);
    }
    const acknowledge = check.buyer_ack?.current ? null : { entrypoint: 'acknowledge_payee', parameter: check.acknowledge?.parameter ?? null, book: 'demo', how: 'POST /api/relay/prepare {sender: payer, entrypoint, parameter, book:"demo"} then sendSponsored, before sending this payment; without it the chain refuses -30 PayeeNotAcknowledged' };
    const invoice = { seller, payable_id: link.payable_id, amount_micro: amount.toString(), asset, register_tx: link.register_tx, book: deps.bookLabel };
    const approvalOut = approval ? { approval_id: approval.approval_id, approval_hash: approval.approval_hash } : null;
    if (rail === 'eudemo') {
      const memo = `payable:${seller}:${link.payable_id}`;
      return {
        rail: 'eudemo',
        check,
        acknowledge,
        invoice: { ...invoice, memo },
        reserve: { entrypoint: 'reserve_plt', parameter: serPayableKey({ seller, payable_id: link.payable_id }).toString('hex'), book: 'demo' },
        transfer: { kind: 'token', token: 'EUDemo', recipient: payee, amount: amount.toString(), memo, book: 'demo', rule: 'The relayer co-signs only a transfer to this payable’s bound payee, for this amount, while it is Reserved by this sender.' },
        confirm: { entrypoint: 'confirm_plt', how: 'POST /api/p/:payee/plt-confirm { payable_id, tx_hash } then prepare + sendSponsored' },
        replay: { entrypoint: 'reserve_plt', parameter: serPayableKey({ seller, payable_id: link.payable_id }).toString('hex'), expect_reject: -16, expect_name: 'WrongStatus' },
        approval: approvalOut,
      };
    }
    if (!deps.payCcdSchema) throw new DashError(503, 'schema_unavailable', 'The wallet parameter schema is not loaded on this server.');
    return {
      rail: 'ccd',
      transaction: {
        type: 'Update', contract: { index: Number(deps.book.index), subindex: Number(deps.book.subindex) }, receive_name: `${deps.book.name}.pay_ccd`,
        amount_micro: amount.toString(), parameter_json: { seller, payable_id: link.payable_id }, schema: { type: 'parameter', value: deps.payCcdSchema }, max_energy: Number(policy.payEnergy),
      },
      check,
      acknowledge,
      invoice,
      approval: approvalOut,
    };
  }

  /** After the EUDemo transfer is finalized: the confirm_plt parameter that records its hash once. */
  async function pltConfirm(payeeIn, body) {
    const payee = addr(payeeIn, 'payee');
    const pid = Number(body?.payable_id);
    const hash = String(body?.tx_hash ?? '').toLowerCase();
    if (!Number.isInteger(pid) || pid < 1) throw new DashError(400, 'bad_payable', 'payable_id is required.');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new DashError(400, 'bad_hash', 'tx_hash must be a 32-byte hex transaction hash.');
    const links = (await kv.list('dash_paylink')).map((r) => r.value).filter((v) => v?.payee === payee && Number(v?.payable_id) === pid);
    if (!links.length) throw new DashError(404, 'no_paylink', 'No EUDemo payment link for that payable.');
    return {
      entrypoint: 'confirm_plt',
      parameter: serConfirmPlt({ seller, payable_id: pid, tx_hash: hash }).toString('hex'),
      book: 'demo',
      invoice: { seller, payable_id: pid, book: deps.bookLabel },
    };
  }

  // ---------------- R5: record ----------------
  async function record(account) {
    const a = addr(account);
    const rows = (await kv.list('dash_record')).map((r) => r.value).filter((v) => v?.account === a);
    const links = (await kv.list('dash_paylink_by_payer')).filter((r) => String(r.key).startsWith(`${a}:`)).map((r) => r.value).slice(-20);
    for (const l of links) {
      const p = await chain.getPayable(l.payable_id).catch(() => null);
      if (p?.status?.tag !== 'Paid') continue;
      const tx = p.status.tx_hash ?? (chain.findPayTx ? await chain.findPayTx(a, p.status.paid_at_ms).catch(() => null) : null);
      rows.push({ at: iso(p.status.paid_at_ms), role: 'paid', counterparty: l.payee, amount_display: microToDisplay(l.amount_micro, l.asset === 'EUDemo' ? 'EUDemo' : 'CCD'), verdict: l.verdict, tx_hash: tx });
    }
    const items = rows.map(({ at, role, counterparty, amount_display, verdict, tx_hash, note }) => ({ at, role, counterparty, amount_display, verdict, tx_hash: tx_hash ?? null, ...(note ? { note } : {}) }))
      .sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 50);
    return { account: a, book: deps.bookLabel, items };
  }

  return { propose, payeeStatus, startGetPaid, getJob, redirect, payTx, pltConfirm, record, _op: op, _running: running };
}
