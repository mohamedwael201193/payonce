// G13 attack-catalogue fixtures on the v3 DEMO book (testnet). Run once as a Render job:
//   PAYONCE_V3_INDEX=13173 node scripts/attack-fixtures.mjs
// Creates the on-chain states some refusals need, all with seed-derived keys (never printed):
//   F1/F2  impostor X (identity 1 cred 48, the demo run's impostor) re-proposed + re-accepted, so the older invoice
//          123 to X carries a stale payee version -> paying it is refused -31 PayeeChanged ("bank details changed").
//   F3     Y = an alias of X, proposed and deliberately never accepted -> -33/-34 (accept with the wrong anchor/version)
//          and -28 (invoice to a payee that never accepted).
//   F4/F5  X funded 1 CCD and set strict (buyer policy) -> X paying any unapproved seller is refused -19.
// Every step is guarded by chain state (re-running is a no-op), and every tx hash is stored in kv BEFORE it is sent;
// a step with an unknown outcome is never sent again (the script stops and reports it).
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Transaction, Payload,
  TransactionHash, ConcordiumHdWallet, getAccountAddress, buildBasicAccountSigner,
} from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { V3, v3Label, getPayeeRecord, getPayableV3, invokeV3, serProposePayee, serAcceptPayee, acct } from '../src/vop-chain.mjs';
import { createRelayer } from '../src/relayer.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';
import { createHash } from 'node:crypto';

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
const out = { book: v3Label(), X: X.address, Y, steps: [] };

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
    const o = await settle(prev.hash, 60_000);
    if (o.state === 'finalized') { out.steps.push({ key, hash: prev.hash, ...o, reused: true }); if (!o.ok) throw new Error(`${key} was rejected ${o.reject} (${prev.hash})`); return prev.hash; }
    throw new Error(`${key}: earlier tx ${prev.hash} has status ${o.state}; not sending again`);
  }
  const { tx, send } = await build();
  const hash = Buffer.from(Transaction.getAccountTransactionHash(tx)).toString("hex");
  await kvPut(NS, key, { hash, state: 'sent', at: new Date().toISOString() });
  await send(tx);
  const o = await settle(hash);
  await kvPut(NS, key, { hash, state: o.state, ok: o.ok ?? null, reject: o.reject ?? null, at: new Date().toISOString() });
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
    await tracked('f5_strict_x', () => ownTx(X, 'set_strict', Buffer.from([1]), { energy: 5000n }));
  }
  out.X_strict = await strictOf(X.address);
  out.ok = true;
} catch (e) {
  out.ok = false; out.error = String(e?.message ?? e);
}
await kvPut(NS, 'last', { ...JSON.parse(J(out)), at: new Date().toISOString() });
console.log(`ATTACK_FX ${J(out)}`);
process.exit(out.ok ? 0 : 1);
