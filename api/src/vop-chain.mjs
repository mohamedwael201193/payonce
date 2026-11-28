// PayOnce — Verification of Payee: chain adapters for payable_registry_v3.
//
// Reads (keyless, any node): the payee book (get_payee), buyer
// acknowledgments (get_ack), v3 payables (get_payable), the v3 config, and
// the payee account's credentials (credential id + identity-provider index,
// public on chain). Writes are built here as parameters only; signing lives
// with the caller (relayer.mjs sponsors them, the agent signs as sender).
//
// Byte layouts mirror contracts/payable_registry_v3/src/lib.rs (concordium-std
// Serial: little-endian ints, Option = 0/1 tag, enums = u8 tag, AccountAddress
// = 32 raw bytes, Timestamp = u64 ms).
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, BlockHash,
} from '@concordium/web-sdk';
import { ENV } from './config.mjs';

export const V3 = Object.freeze({
  index: BigInt(ENV.PAYONCE_V3_INDEX ?? 13172),
  subindex: BigInt(ENV.PAYONCE_V3_SUBINDEX ?? 0),
  name: 'payable_registry_v3',
  moduleRef: ENV.PAYONCE_V3_MODULE ?? '8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946',
});
export const v3Label = (book = V3) => `<${book.index},${book.subindex}>`;
/** A handle for another instance of the same module (e.g. the 90 s demo book). */
export function bookAt(index, subindex = 0) {
  return Object.freeze({ index: BigInt(index), subindex: BigInt(subindex), name: V3.name, moduleRef: V3.moduleRef });
}
export const DEMO_V3 = bookAt(ENV.PAYONCE_DEMO_BOOK_INDEX ?? 13173, ENV.PAYONCE_DEMO_BOOK_SUBINDEX ?? 0);

export const PAYEE_STATUS = ['Proposed', 'Bound', 'Revoked'];
export const PAYABLE_STATUS = ['Unpaid', 'Reserved', 'Paid', 'Voided'];
/** v3 reject codes (frozen -1..-27 from v2.1; -28..-36 new in v3). */
export const V3_ERRORS = {
  '-28': 'PayeeNotBound', '-29': 'PayeeNotMature', '-30': 'PayeeNotAcknowledged', '-31': 'PayeeChanged',
  '-32': 'PayeeNotProposed', '-33': 'AnchorMismatch', '-34': 'PayeeVersionMismatch', '-35': 'NotPayeeParty', '-36': 'VerdictNotPayable',
};

// ---------------- serializers ----------------
export const acct = (a) => Buffer.from(AccountAddress.fromBase58(a).decodedAddress);
const u8 = (n) => Buffer.from([Number(n) & 0xff]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const h32 = (hex, what) => {
  const s = String(hex ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${what}: expected 32-byte hex`);
  return Buffer.from(s, 'hex');
};
const opt = (v, enc) => (v == null ? u8(0) : Buffer.concat([u8(1), enc(v)]));

/** PayeeIdentity { kind u8, idp_index u32, legal_name_hash [32], country [2], proof_anchor [32], anchor_tx Option<[32]> } */
export function serPayeeIdentity(id) {
  const country = String(id.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('identity.country: ISO 3166-1 alpha-2');
  if (![1, 2].includes(Number(id.kind))) throw new Error('identity.kind: 1 business or 2 person');
  return Buffer.concat([
    u8(id.kind), u32(id.idp_index), h32(id.legal_name_hash, 'legal_name_hash'), Buffer.from(country, 'ascii'),
    h32(id.proof_anchor, 'proof_anchor'), opt(id.anchor_tx, (t) => h32(t, 'anchor_tx')),
  ]);
}
export const serProposePayee = ({ payee, agent_token, identity }) => Buffer.concat([acct(payee), u64(agent_token), serPayeeIdentity(identity)]);
export const serAcceptPayee = ({ seller, version, proof_anchor }) => Buffer.concat([acct(seller), u32(version), h32(proof_anchor, 'proof_anchor')]);
export const serPayeeRef = ({ seller, payee }) => Buffer.concat([acct(seller), acct(payee)]);
export const serAcknowledgePayee = ({ seller, payee, version, verdict, evidence_hash }) => Buffer.concat([acct(seller), acct(payee), u32(version), u8(verdict), h32(evidence_hash, 'evidence_hash')]);
export const serGetAck = ({ buyer, seller, payee }) => Buffer.concat([acct(buyer), acct(seller), acct(payee)]);
export const serPayableKey = ({ seller, payable_id }) => Buffer.concat([acct(seller), u64(payable_id)]);
function serAsset(asset) {
  if (asset == null || asset === 'CCD' || asset?.Ccd !== undefined) return u8(0);
  const name = typeof asset === 'string' ? asset : asset.Plt;
  const b = Buffer.from(String(name), 'utf8');
  return Buffer.concat([u8(1), u32(b.length), b]);
}
/** RegisterPayableParam { payable_id, payee, amount, asset, due (ms), doc_hash, agent_token, expected_payer?, legal_ref? } */
export const serRegisterPayable = (p) => Buffer.concat([
  u64(p.payable_id), acct(p.payee), u64(p.amount), serAsset(p.asset), u64(p.due_ms), h32(p.doc_hash, 'doc_hash'),
  u64(p.agent_token), opt(p.expected_payer, acct), opt(p.legal_ref, (r) => h32(r, 'legal_ref')),
]);
export const serConfirmPlt = ({ seller, payable_id, tx_hash }) => Buffer.concat([acct(seller), u64(payable_id), h32(tx_hash, 'tx_hash')]);

// ---------------- parsers ----------------
class R {
  constructor(buf) { this.b = Buffer.from(buf); this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error(`v3 view truncated at ${this.o}+${n}/${this.b.length}`); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return Buffer.from(v); }
  hex32() { return this.bytes(32).toString('hex'); }
  addr() { return AccountAddress.fromBuffer(this.bytes(32)).address; }
  opt(fn) { const t = this.u8(); if (t === 0) return null; if (t !== 1) throw new Error(`bad Option tag ${t}`); return fn(); }
  ts() { return Number(this.u64()); }
  str() { const n = this.u32(); return this.bytes(n).toString('utf8'); }
  done() { if (this.o !== this.b.length) throw new Error(`v3 view has ${this.b.length - this.o} trailing bytes`); }
}

function readIdentity(r) {
  return {
    kind: r.u8(), idp_index: r.u32(), legal_name_hash: r.hex32(), country: r.bytes(2).toString('ascii'),
    proof_anchor: r.hex32(), anchor_tx: r.opt(() => r.hex32()),
  };
}
/** Option<PayeeRecord> -> record | null */
export function parsePayeeRecord(buf) {
  const r = new R(buf);
  const rec = r.opt(() => {
    const seller = r.addr(); const payee = r.addr(); const identity = readIdentity(r);
    const st = r.u8();
    if (st > 2) throw new Error(`bad PayeeStatus ${st}`);
    return {
      seller, payee, identity, status: PAYEE_STATUS[st], version: r.u32(), proposed_at_ms: r.ts(),
      bound_at_ms: r.opt(() => r.ts()), mature_at_ms: r.opt(() => r.ts()),
    };
  });
  r.done();
  return rec;
}
/** Option<PayeeAck> -> ack | null */
export function parsePayeeAck(buf) {
  const r = new R(buf);
  const ack = r.opt(() => ({ version: r.u32(), verdict: r.u8(), evidence_hash: r.hex32(), at_ms: r.ts() }));
  r.done();
  return ack;
}
/** Option<Payable> (v3 layout: payee_version u32 sits between legal_ref and status). */
export function parsePayableV3(buf) {
  const r = new R(buf);
  const p = r.opt(() => {
    const seller = r.addr(); const payable_id = r.u64().toString(); const payee = r.addr(); const amount = r.u64().toString();
    const at = r.u8(); const asset = at === 0 ? 'CCD' : at === 1 ? r.str() : (() => { throw new Error(`bad Asset ${at}`); })();
    const due_ms = r.ts(); const doc_hash = r.hex32(); const agent_token = r.u64().toString();
    const expected_payer = r.opt(() => r.addr()); const legal_ref = r.opt(() => r.hex32()); const payee_version = r.u32();
    const st = r.u8(); let status;
    if (st === 0) status = { tag: 'Unpaid' };
    else if (st === 1) status = { tag: 'Reserved', payer: r.addr(), reserved_at_ms: r.ts(), expires_ms: r.ts() };
    else if (st === 2) status = { tag: 'Paid', payer: r.addr(), reservation_expires_ms: r.opt(() => r.ts()), paid_at_ms: r.ts(), tx_hash: r.opt(() => r.hex32()) };
    else if (st === 3) status = { tag: 'Voided', at_ms: r.ts() };
    else throw new Error(`bad Status ${st}`);
    return { seller, payable_id, payee, amount, asset, due_ms, doc_hash, agent_token, expected_payer, legal_ref, payee_version, status };
  });
  r.done();
  return p;
}
export function parseConfigV3(buf) {
  const r = new R(buf);
  const cfg = { cis8004: `<${r.u64()},${r.u64()}>`, reservation_secs: Number(r.u64()), cooling_off_secs: Number(r.u64()) };
  r.done();
  return cfg;
}

// ---------------- node reads ----------------
export async function invokeV3(c, method, paramBuf = Buffer.alloc(0), blockHashHex = null, book = V3) {
  const res = await c.invokeContract(
    { contract: ContractAddress.create(book.index, book.subindex), method: ReceiveName.fromString(`${book.name}.${method}`), parameter: Parameter.fromBuffer(paramBuf) },
    blockHashHex ? BlockHash.fromHexString(blockHashHex) : undefined,
  );
  if (res.tag !== 'success') {
    const code = res.reason?.rejectReason ?? res.reason?.contents?.rejectReason;
    throw new Error(`v3 ${method} invoke failed${code != null ? ` (${code})` : ''}`);
  }
  const rv = res.returnValue;
  return Buffer.from(rv instanceof Uint8Array ? rv : rv?.buffer ?? []);
}
export const getPayeeRecord = async (c, seller, payee, book = V3) => parsePayeeRecord(await invokeV3(c, 'get_payee', serPayeeRef({ seller, payee }), null, book));
export const getPayeeAck = async (c, buyer, seller, payee, book = V3) => parsePayeeAck(await invokeV3(c, 'get_ack', serGetAck({ buyer, seller, payee }), null, book));
export const getPayableV3 = async (c, seller, payable_id, book = V3) => parsePayableV3(await invokeV3(c, 'get_payable', serPayableKey({ seller, payable_id }), null, book));
export const getConfigV3 = async (c, book = V3) => parseConfigV3(await invokeV3(c, 'get_config', Buffer.alloc(0), null, book));

const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
/** Public identity facts of an account: its credentials' registration ids and identity-provider indexes. */
export function credentialsOf(accountInfoJson) {
  const out = [];
  for (const entry of Object.values(accountInfoJson?.accountCredentials ?? {})) {
    const c = entry?.value?.contents ?? entry?.contents ?? {};
    const credId = c.credId ?? c.regId ?? null;
    const idp = c.ipIdentity ?? c.ipId ?? null;
    if (idp != null) out.push({ credId: credId ? String(credId).toLowerCase() : null, idp: Number(idp), type: entry?.value?.type ?? null });
  }
  return out;
}
export async function accountIdentity(c, address) {
  try {
    const info = jsonSafe(await c.getAccountInfo(AccountAddress.fromBase58(address)));
    return { exists: true, address, credentials: credentialsOf(info) };
  } catch (e) {
    if (/not found|NOT_FOUND|5 /i.test(String(e?.message ?? e)) || Number(e?.code) === 5) return { exists: false, address, credentials: [] };
    throw e;
  }
}
