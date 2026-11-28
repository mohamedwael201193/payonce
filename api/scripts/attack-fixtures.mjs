// G13 attack-catalogue fixtures on the v3 DEMO book (testnet). Run once as a Render job:
//   PAYONCE_V3_INDEX=13173 node scripts/attack-fixtures.mjs
// Creates the on-chain states some refusals need, all with seed-derived keys (never printed):
//   F1/F2  impostor X (identity 1 cred 48, the demo run's impostor) re-proposed + re-accepted, so the older invoice
//          123 to X carries a stale payee version -> paying it is refused -31 PayeeChanged ("bank details changed").
//   F3     Y = an alias of X, proposed and deliberately never accepted -> -33/-34 (accept with the wrong anchor/version)
//          and -28 (invoice to a payee that never accepted).
//   F4/F5  X funded 1 CCD and set strict (buyer policy) -> X paying any unapproved seller is refused -19.
//   F6     open invoice 777000001 to the bound real payee with NO expected payer (0.01 CCD), so the strict-buyer
//          attack reaches the strict check (-19) instead of the expected-payer check (-21).
// Every step is guarded by chain state (re-running is a no-op), and every tx hash is stored in kv BEFORE it is sent;
// a step with an unknown outcome is never sent again (the script stops and reports it).
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Transaction, Payload,
  TransactionHash, ConcordiumHdWallet, getAccountAddress, buildBasicAccountSigner,
} from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { V3, v3Label, getPayeeRecord, getPayableV3, invokeV3, serProposePayee, serAcceptPayee, serRegisterPayable, acct } from '../src/vop-chain.mjs';
import { createRelayer } from '../src/relayer.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';
import { createHash } from 'node:crypto';
import { hashCandidates, returnedHash } from '../src/tx-hash.mjs';

if (String(V3.index) !== '13173') { console.log('refusing: fixtures go on the demo book <13173,0> only (set PAYONCE_V3_INDEX=13173)'); process.exit(1); }
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WP = 'https://wallet-proxy.testnet.concordium.com';
const NS = 'attack_fx';
const c = vClient();
const S = await signers();
const OWNER = S.owner;
const relayer = createRelayer({ grpc: async () => c, sponsor: async () => S.owner });
const hd = ConcordiumHdWallet.fromSeedPhrase((process.env.CONCORDIUM_WALLET_SEED_PHRASE || '').trim(), 'Testnet');
const g = (await (await fetch(`${WP}/v0/global`)).json()).value;
const X_CRED = 48;
const X = { address: getAccountAddress(Buffer.from(hd.getCredentialId(0, 1, X_CRED, g)).toString('hex')).address, signer: buildBasicAccountSigner(hd.getAccountSigningKey(0, 1, X_CRED).toString('hex')) };
const EXPECT_X = '3GPTo1LQbwHcsxPLBmWAVAA4RF6FvbDkzbf7DvLkEKpxWMboHq';
if (X.address !== EXPECT_X) { console.log('refusing: identity 1 cred 48 is not the demo impostor on this seed'); process.exit(1); }
const xb = Buffer.from(AccountAddress.fromBase58(X.address).decodedAddress);
const Y = AccountAddress.fromBuffer(Buffer.concat([xb.subarray(0, 29), Buffer.from([0, 0, 1])])).address;
const OLD_INVOICE = 123;
const out = { book: v3Label(), X: X.address, Y, steps: [], hash_check: [] };
// f1 was sent on the first run (28 Nov 10:42:09 Cairo) and stored under the SDK's pre-send hash 000496c4..., which the
// node does not know (tx-hash.mjs). Its node hash, read back from wallet-proxy, is accepted only if the chain confirms it.
const KNOWN = { f1_repropose_x: '9ea8268ba410911e041f5bf898088415db2cfc1ce92fd950d5eb5464b6f8bfbc' };

async function outcome(h) {
  try {
    const s = JSON.parse(J(await c.getBlockItemStatus(TransactionHash.fromHexString(h))));
    if (s.status !== 'finalized') return { state: s.status ?? 'pending' };
    const sum = s.outcome?.summary ?? {};
    const rr = sum.rejectReason?.rejectReason ?? sum.rejectReason?.contents?.rejectReason ?? null;
    return { state: 'finalized', ok: !sum.rejectReason, reject: rr != null ? Number(rr) : null };
  } catch (e) { return { state: /not found/i.test(String(e?.message)) ? 'absent' : 'unknown', error: String(e?.message ?? e).slice(0, 120) }; }
}
async function settle(h, ms = 120_000) {
  const t0 = Date.now();
  for (;;) { const o = await outcome(h); if (o.state === 'finalized') return o; if (Date.now() - t0 > ms) return o; await sleep(2500); }
}
/** step key -> build() returns a finalized signed tx (hash known); stored before send; unknown -> stop. */
async function tracked(key, build) {
  const prev = await kvGet(NS, key);
  if (prev?.hash) {
    for (const h of [...new Set([prev.hash, ...(prev.candidates ?? []), ...(KNOWN[key] ? [KNOWN[key]] : [])])]) {
      const o = await settle(h, 20_000);
      if (o.state === 'finalized') {
        await kvPut(NS, key, { ...prev, hash: h, state: 'finalized', ok: o.ok, reject: o.reject ?? null });
        out.steps.push({ key, hash: h, ...o, reused: true });
        if (!o.ok) throw new Error(`${key} was rejected ${o.reject} (${h})`);
        return h;
      }
    }
    // Absent under every candidate after its expiry + 60 s: it can never execute, so a new transaction cannot double-run.
    const expiry = Number(prev.expiry_ms ?? (Date.parse(prev.at) + 8 * 60_000));
    const expiredUnseen = prev.state === 'sent' && Date.now() >= expiry + 60_000;
    if (prev.state !== 'not_sent' && !expiredUnseen) throw new Error(`${key}: earlier tx ${prev.hash} (${prev.state}) is not finalized and not provably dead; not sending again`);
    out.steps.push({ key, previous: prev.hash, note: prev.state === 'not_sent' ? 'refused by the node before acceptance; building a new one' : 'absent after expiry; building a new one' });
  }
  const { tx, send } = await build();
  const candidates = hashCandidates(tx);
  const expiry_ms = Number(tx.header?.expiry?.expiryEpochSeconds ?? 0) * 1000 || Date.now() + 8 * 60_000;
  await kvPut(NS, key, { hash: candidates[0], candidates, expiry_ms, state: 'sent', at: new Date().toISOString() });
  let got;
  try { got = returnedHash(await send(tx)); } catch (e) {
    const m = String(e?.message ?? e);
    // the node refused it before acceptance (gRPC InvalidArgument): nothing was sent
    if (/enough funds|duplicate nonce|nonce too|invalid signature|expired/i.test(m)) await kvPut(NS, key, { hash: candidates[0], candidates, expiry_ms, state: 'not_sent', error: m.slice(0, 160), at: new Date().toISOString() });
    throw e;
  }
  const hash = got ?? candidates[0];
  out.hash_check.push({ key, version: tx.version, node: got, block_item_hash_matches: got === candidates[0], sdk_hash_matches: got === candidates[candidates.length - 1] });
  await kvPut(NS, key, { hash, candidates, state: 'sent', at: new Date().toISOString() });
  const o = await settle(hash);
  await kvPut(NS, key, { hash, candidates, state: o.state, ok: o.ok ?? null, reject: o.reject ?? null, at: new Date().toISOString() });
  out.steps.push({ key, hash, ...o });
  if (o.state !== 'finalized') throw new Error(`${key}: ${hash} not finalized yet (${o.state}); not sending again`);
  if (!o.ok) throw new Error(`${key} rejected ${o.reject} (${hash})`);
  return hash;
}
async function ownTx(from, entrypoint, param, { amount = 0n, energy = 30000n } = {}) {
  const info = await c.getAccountInfo(AccountAddress.fromBase58(from.address));
  const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(amount), address: ContractAddress.create(V3.index, V3.subindex), receiveName: ReceiveName.fromString(`${V3.name}.${entrypoint}`), message: Parameter.fromBuffer(param) }), Energy.create(energy))
    .addMetadata({ sender: AccountAddress.fromBase58(from.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const fin = await Transaction.signAndFinalize(tx, from.signer);
  return { tx: fin, send: (t) => c.sendTransaction(t) };
}
async function transferTx(from, to, micro) {
  const info = await c.getAccountInfo(AccountAddress.fromBase58(from.address));
  const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(micro), toAddress: AccountAddress.fromBase58(to) })
    .addMetadata({ sender: AccountAddress.fromBase58(from.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const fin = await Transaction.signAndFinalize(tx, from.signer);
  return { tx: fin, send: (t) => c.sendTransaction(t) };
}
async function sponsoredTx(from, entrypoint, param) {
  const p = await relayer.prepare({ sender: from.address, entrypoint, parameter: param.toString('hex'), amount_micro_ccd: '0' });
  const signed = await Transaction.sign(Transaction.signableFromJSON(p.transaction), from.signer);
  const fin = Transaction.finalize(signed);
  return { tx: fin, send: (t) => c.sendTransaction(t) };
}
const strictOf = async (a) => (await invokeV3(c, 'get_buyer_policy', acct(a)))[0] === 1;
const balance = async (a) => { const i = JSON.parse(J(await c.getAccountInfo(AccountAddress.fromBase58(a)))); return BigInt(i.accountAmount?.microCcdAmount ?? i.accountAmount); };

try {
  // F1/F2: stale version on invoice 123 (payee X changed after the invoice was registered).
  const inv = await getPayableV3(c, OWNER.address, OLD_INVOICE);
  if (!inv || inv.payee !== X.address) throw new Error(`invoice ${OLD_INVOICE} is not an invoice to X on this book`);
  let rec = await getPayeeRecord(c, OWNER.address, X.address);
  out.invoice = { id: OLD_INVOICE, payee_version: inv.payee_version, status: inv.status.tag };
  if (rec.status === 'Bound' && rec.version === inv.payee_version) {
    await tracked('f1_repropose_x', () => ownTx(OWNER, 'propose_payee', serProposePayee({ payee: X.address, agent_token: OWNER_TOKEN, identity: rec.identity })));
    rec = await getPayeeRecord(c, OWNER.address, X.address);
  }
  if (rec.status === 'Proposed') {
    await tracked(`f2_accept_x_v${rec.version}`, () => sponsoredTx(X, 'accept_payee', serAcceptPayee({ seller: OWNER.address, version: rec.version, proof_anchor: rec.identity.proof_anchor })));
    rec = await getPayeeRecord(c, OWNER.address, X.address);
  }
  out.X_record = { status: rec.status, version: rec.version, mature_at_ms: rec.mature_at_ms };
  // F3: Y proposed, never accepted.
  let ry = await getPayeeRecord(c, OWNER.address, Y);
  if (!ry) {
    const identity = { ...rec.identity, proof_anchor: createHash('sha256').update(`PayOnce attack fixture: proposal never accepted by ${Y}`).digest('hex') };
    await tracked('f3_propose_y', () => ownTx(OWNER, 'propose_payee', serProposePayee({ payee: Y, agent_token: OWNER_TOKEN, identity })));
    ry = await getPayeeRecord(c, OWNER.address, Y);
  }
  out.Y_record = { status: ry.status, version: ry.version };
  // F4/F5: X funded and strict.
  if (!(await strictOf(X.address))) {
    if ((await balance(X.address)) < 500_000n) await tracked('f4_fund_x', () => transferTx(OWNER, X.address, 1_000_000n));
    // testnet energy is ~0.008 CCD/NRG: the sender must hold max-energy x price, so X gets 20 CCD and a tight cap
    if ((await balance(X.address)) < 15_000_000n) await tracked('f4b_fund_x', () => transferTx(OWNER, X.address, 20_000_000n));
    await tracked('f5_strict_x', () => ownTx(X, 'set_strict', Buffer.from([1]), { energy: 1500n }));
  }
  out.X_strict = await strictOf(X.address);
  // F6: open invoice, no expected payer.
  const OPEN = 777000001;
  if (!(await getPayableV3(c, OWNER.address, OPEN))) {
    await tracked('f6_open_invoice', () => ownTx(OWNER, 'register_payable', serRegisterPayable({ payable_id: OPEN, payee: OWNER.address, amount: 10_000n, asset: 'CCD', due_ms: Date.parse('2027-03-01T00:00:00Z'), doc_hash: createHash('sha256').update('PayOnce attack fixture: open invoice, no expected payer').digest('hex'), agent_token: OWNER_TOKEN, expected_payer: null, legal_ref: null })));
  }
  const op = await getPayableV3(c, OWNER.address, OPEN);
  out.open_invoice = { id: OPEN, status: op?.status?.tag ?? null, expected_payer: op?.expected_payer ?? null };
  out.ok = true;
} catch (e) {
  out.ok = false; out.error = String(e?.message ?? e);
}
await kvPut(NS, 'last', { ...JSON.parse(J(out)), at: new Date().toISOString() });
console.log(`ATTACK_FX ${J(out)}`);
process.exit(out.ok ? 0 : 1);
