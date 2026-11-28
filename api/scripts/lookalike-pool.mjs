// Builds the lookalike impostor pool for demo-run.mjs: seed identity-1 credential slots whose account starts like the
// real payee, plus the account alias (same account, last 3 address bytes free) whose base58 tail matches the real
// payee's tail. Prints and writes only public data (credential numbers, addresses, alias indexes); keys never leave
// the process. Run: CONCORDIUM_WALLET_SEED_PHRASE=... node api/scripts/lookalike-pool.mjs [size]
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';

const REAL = process.env.LOOKALIKE_TARGET ?? '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const SIZE = Number(process.argv[2] ?? 8);
const FROM = Number(process.env.LOOKALIKE_FROM_CRED ?? 60);
const WP = 'https://wallet-proxy.testnet.concordium.com';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58ToBig(s) { let v = 0n; for (const ch of s) v = v * 58n + BigInt(B58.indexOf(ch)); return v; }
const sha = (b) => createHash('sha256').update(b).digest();

/** alias index in [0, 2^24) whose base58 address shares the longest tail (<= maxK chars) with target. */
export function bestAlias(canonical, target, maxK = 4) {
  const raw = Buffer.from(sdk.AccountAddress.fromBase58(canonical).decodedAddress); // 32 bytes
  const head = Buffer.concat([Buffer.from([1]), raw.subarray(0, 29)]); // version + 29 fixed bytes
  const tv = b58ToBig(target);
  let best = { k: 0, index: null };
  for (let k = maxK; k >= 2 && best.index == null; k--) {
    const M = 58n ** BigInt(k);
    const T = Number(tv % M); const Mn = Number(M);
    let a = 0n; for (const x of head) a = a * 256n + BigInt(x);
    const aM = Number(a % M); const p56 = Number((1n << 56n) % M); const p32 = Number((1n << 32n) % M);
    const hp = Number((BigInt(aM) * BigInt(p56)) % M);
    const buf = Buffer.alloc(33); head.copy(buf, 0);
    for (let i = 0; i < 1 << 24; i++) {
      buf[30] = i >>> 16; buf[31] = (i >>> 8) & 255; buf[32] = i & 255;
      const chk = sha(sha(buf)).readUInt32BE(0);
      const v = (hp + ((i * p32) % Mn) + (chk % Mn)) % Mn;
      if (v === T) { best = { k, index: i }; break; }
    }
  }
  if (best.index == null) return null;
  const aliasBytes = Buffer.concat([raw.subarray(0, 29), Buffer.from([best.index >>> 16, (best.index >>> 8) & 255, best.index & 255])]);
  const alias = sdk.AccountAddress.fromBuffer(aliasBytes).address;
  return { alias, alias_index: best.index, suffix_match: best.k };
}
const prefixMatch = (a, b) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return n; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = (process.env.CONCORDIUM_WALLET_SEED_PHRASE || '').trim();
  if (!seed) { console.error('CONCORDIUM_WALLET_SEED_PHRASE missing'); process.exit(1); }
  const hd = sdk.ConcordiumHdWallet.fromSeedPhrase(seed, 'Testnet');
  const g = (await (await fetch(`${WP}/v0/global`)).json()).value;
  const picks = [];
  for (let cred = FROM; cred < 200 && picks.length < SIZE; cred++) {
    const canonical = sdk.getAccountAddress(Buffer.from(hd.getCredentialId(0, 1, cred, g)).toString('hex')).address;
    if (canonical[0] !== REAL[0]) continue;
    const ex = await fetch(`${WP}/v0/accBalance/${canonical}`).then((x) => x.json()).catch(() => null);
    if (ex?.finalizedBalance || ex?.currentBalance) continue;
    const t = Date.now();
    const al = bestAlias(canonical, REAL);
    if (!al) continue;
    const e = { identity: 1, cred, canonical, ...al, prefix_match: prefixMatch(al.alias, REAL) };
    picks.push(e);
    console.log(`cred ${cred}: ${al.alias} (prefix ${e.prefix_match}, suffix ${al.suffix_match}) ${Date.now() - t} ms`);
  }
  const out = { target: REAL, note: 'Lookalike impostors for /demo: seed identity 1 credential slots (public numbers) + account alias. No keys.', generated_at: new Date().toISOString(), pool: picks };
  writeFileSync(new URL('./lookalike-pool.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${picks.length} entries`);
}
