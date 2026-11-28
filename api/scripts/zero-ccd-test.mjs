// zero-ccd-test.mjs — the deciding test: a brand-new account holding 0 CCD binds itself as a payee with ONE
// fee-sponsored accept_payee, via the LIVE sponsor-first endpoint (POST /api/relay/prepare). The script then does
// exactly what Concordium Wallet for Web >= 2.10 `sendSponsoredTransaction` does: add the sender signature, submit.
//   ZERO_CRED=7 ZERO_ADDRESS=<expected> node api/scripts/zero-ccd-test.mjs
// Testnet only. Keys derived in-process from the service env, never printed. Sends once; never resubmits.
import { AccountAddress, Transaction, TransactionHash, ConcordiumHdWallet, buildBasicAccountSigner } from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvPut } from '../src/store.mjs';
import { V3, v3Label, getPayeeRecord, serProposePayee, serAcceptPayee } from '../src/vop-chain.mjs';
import { legalNameHash, canonicalJson, sha256Hex } from '../src/vop.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';
import { ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Payload } from '@concordium/web-sdk';

const API = (process.env.PAYONCE_API_URL ?? 'https://payonce-api-n98a.onrender.com').replace(/\/$/, '');
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const c = vClient();
const cred = Number(process.env.ZERO_CRED ?? 7);
const hd = ConcordiumHdWallet.fromSeedPhrase((process.env.CONCORDIUM_WALLET_SEED_PHRASE || '').trim(), 'Testnet');
const zSigner = buildBasicAccountSigner(hd.getAccountSigningKey(0, 1, cred).toString('hex'));
const Z = process.env.ZERO_ADDRESS;
const S = await signers();
const out = { test: 'zero-ccd sponsored payee binding', contract: v3Label(), api: API, account: Z, credential: `identity 1, credential ${cred}` };
const fin = async (h) => { const s = JSON.parse(J(await c.waitForTransactionFinalization(TransactionHash.fromHexString(h), 180_000))); return { hash: h, block: s.blockHash, summary: s.summary }; };
const bal = async (a) => { const i = JSON.parse(J(await c.getAccountInfo(AccountAddress.fromBase58(a)))); return { ccd_micro: String(i.accountAmount?.microCcdAmount ?? i.accountAmount), nonce: String(i.accountNonce?.value ?? i.accountNonce) }; };

out.before = await bal(Z);
const STANDIN = { account: Z, legal_name: 'PayOnce QA Zero-CCD Payee', country: 'DK', label: 'TESTNET STAND-IN: QA account for the zero-CCD sponsored-binding test; name declared by PayOnce, not proven' };
let rec = await getPayeeRecord(c, S.owner.address, Z);
if (!rec) {
  await kvPut('vop_standin', Z, STANDIN);
  const identity = { kind: 2, idp_index: 0, legal_name_hash: legalNameHash(STANDIN.legal_name), country: 'DK', proof_anchor: sha256Hex(canonicalJson(STANDIN)), anchor_tx: null };
  const info = await c.getAccountInfo(AccountAddress.fromBase58(S.owner.address));
  const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(0n), address: ContractAddress.create(V3.index, V3.subindex), receiveName: ReceiveName.fromString(`${V3.name}.propose_payee`), message: Parameter.fromBuffer(serProposePayee({ payee: Z, agent_token: OWNER_TOKEN, identity })) }), Energy.create(8000n))
    .addMetadata({ sender: AccountAddress.fromBase58(S.owner.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const h = (await c.sendTransaction(await Transaction.signAndFinalize(tx, S.owner.signer))).toString();
  console.log('[propose_payee] sent', h);
  out.propose = await fin(h);
  rec = await getPayeeRecord(c, S.owner.address, Z);
}
out.record_before = rec;
if (rec.status !== 'Proposed') { out.skipped = `payee status is ${rec.status}`; console.log('RESULT', J(out)); process.exit(0); }

const r = await fetch(`${API}/api/relay/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ sender: Z, entrypoint: 'accept_payee', parameter: serAcceptPayee({ seller: S.owner.address, version: rec.version, proof_anchor: rec.identity.proof_anchor }).toString('hex') }) });
const prep = await r.json();
if (!r.ok) { out.prepare_error = prep; console.log('RESULT', J(out)); process.exit(1); }
out.prepare = { mode: prep.mode, sponsor: prep.sponsor, expires_at: prep.expires_at, schema_bytes: prep.schema ? Buffer.from(prep.schema, 'base64').length : 0 };
// Wallet step (what sendSponsoredTransaction does): parse, add the sender signature, submit.
const tx = Transaction.signableFromJSON(prep.transaction);
const finalized = Transaction.finalize(await Transaction.sign(tx, zSigner));
const h = (await c.sendTransaction(finalized)).toString();
console.log('[accept_payee] sent (sender holds 0 CCD)', h);
out.accept = await fin(h);
out.after = await bal(Z);
out.record_after = await getPayeeRecord(c, S.owner.address, Z);
out.go = out.accept.summary?.transactionType === 'update' && out.after.ccd_micro === '0' && out.record_after?.status === 'Bound';
console.log('RESULT', J(out));
process.exit(0);
