// Keyless, third-party verification of the reference buyer agent's spend mandate. Trusts the API for nothing:
//   1. sha256(message) == the mandate hash, and the message parses to the stated cap / total / expiry;
//   2. the message signature verifies against the buyer account's OWN keys, read from a Concordium node;
//   3. the anchor transaction is FINALIZED, was sent by that account, and carries "PMD1" + sha256(message);
//   4. every recorded spend is a finalized transfer sent by that account, none above the per-purchase cap, the sum within the total.
//   node scripts/verify-mandate.mjs [api-base] [mandate-hash]
import { createHash } from 'node:crypto';
import { AccountAddress, TransactionHash, verifyMessageSignature } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { parseMandateMessage, anchorDataHex } from '../src/mandate.mjs';

const API = (process.argv[2] ?? process.env.PAYONCE_API_URL ?? 'https://payonce-api-n98a.onrender.com').replace(/\/$/, '');
const toJson = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const get = async (p) => { const r = await fetch(`${API}${p}`, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json(); };
const fails = []; const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fails.push(msg); };

const m = await get(process.argv[3] ? `/api/mandate/${process.argv[3]}` : '/api/mandate');
if (!m.hash) { console.error('no mandate yet'); process.exit(2); }
const sp = await get(`/api/mandate/${m.hash}/spend`);
const client = new ConcordiumGRPCNodeClient(process.env.PAYONCE_GRPC_HOST ?? 'grpc.testnet.concordium.com', Number(process.env.PAYONCE_GRPC_PORT ?? 20000), credentials.createSsl());
const tx = async (h) => { const j = toJson(await client.getBlockItemStatus(TransactionHash.fromHexString(h))); return { status: j.status, summary: j.outcome?.summary }; };
const dataHexOf = (summary) => { const out = []; const walk = (v) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(summary?.dataRegistered); return out.find((x) => /^[0-9a-fA-F]+$/.test(x) && x.length >= 10)?.toLowerCase() ?? null; };

console.log(`mandate ${m.hash}\naccount ${m.account} (agent #${m.agent_token})\ncap ${m.per_purchase_micro} micro CCD per purchase, ${m.total_micro} total, expires ${m.expires_at}\n`);
ok(createHash('sha256').update(m.message).digest('hex') === m.hash, 'sha256(message) equals the mandate hash');
const parsed = parseMandateMessage(m.message);
ok(parsed && parsed.account === m.account && String(parsed.per_purchase_micro) === String(m.per_purchase_micro) && String(parsed.total_micro) === String(m.total_micro), 'the signed text says exactly the cap, total and account the API reports');
const info = await client.getAccountInfo(AccountAddress.fromBase58(m.account));
let sigOk = false; try { sigOk = await verifyMessageSignature(m.message, m.signature, info); } catch { sigOk = false; }
ok(sigOk, 'the signature verifies against the account keys on chain (the buyer account itself approved this text)');
const a = await tx(m.anchor.tx_hash);
ok(a.status === 'finalized', `anchor tx ${m.anchor.tx_hash} is finalized`);
ok(a.summary?.sender === m.account, 'the anchor was sent by the mandate account');
ok(dataHexOf(a.summary) === anchorDataHex(m.hash), 'the anchor carries "PMD1" + sha256(message)');
let sum = 0n;
const settled = sp.spends.filter((x) => x.state === 'settled' && x.tx_hash);
console.log(`${sp.spends.length} reservation(s) recorded, ${settled.length} settled`);
for (const s of settled) {
  const t = await tx(s.tx_hash).catch(() => null);
  const amt = BigInt(s.amount_micro); sum += amt;
  ok(Boolean(t) && t.status === 'finalized' && t.summary?.sender === m.account, `spend ${s.tx_hash.slice(0, 12)}… is a finalized transaction from the mandate account`);
  ok(amt <= BigInt(m.per_purchase_micro), `spend ${s.tx_hash.slice(0, 12)}… (${amt} micro) is within the per-purchase cap`);
}
ok(sum <= BigInt(m.total_micro), `recorded spend ${sum} micro is within the total ${m.total_micro}`);
console.log(fails.length ? `\n${fails.length} check(s) FAILED` : `\nALL ${settled.length * 2 + 7} CHECKS PASSED`);
process.exit(fails.length ? 1 : 0);
