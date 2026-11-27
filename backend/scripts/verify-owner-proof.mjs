// Re-verify the PayOnce owner proof (Verify & Access V1, Concordium TESTNET) from the published record only.
// Usage: node backend/scripts/verify-owner-proof.mjs [path-or-url]   (default: the live site's /proofs/owner-proof.json)
// Reads the public testnet node. No keys, no sends. Needs: npm ci --prefix backend
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const src = process.argv[2] ?? 'https://payonce-tau.vercel.app/proofs/owner-proof.json';
const doc = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, 'utf8'));
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const { VerificationAuditRecordV1, VerificationRequestV1, VerifiablePresentationV1, CredentialRegistrationId } = sdk;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const rec = VerificationAuditRecordV1.fromJSON(doc.record);
const given = rec.request.context.given ?? [];
check('request nonce == sha256(statement text)', Buffer.from(given.find(g => g.label === 'Nonce')?.context ?? []).toString('hex') === createHash('sha256').update(doc.text).digest('hex'));
check('statement text is in the request context', given.some(g => g.label === 'ContextString' && g.context === doc.text));
const vaa = await VerificationAuditRecordV1.verifyAnchor(rec, sdk.TransactionHash.fromHexString(doc.anchors.vaa), client).then(() => true, e => String(e.message).slice(0, 120));
check('VAA anchor on chain matches the record', vaa === true, `tx ${doc.anchors.vaa.slice(0, 12)}...`);
const vra = await VerificationRequestV1.verifyAnchor(rec.request, client).then(() => true, e => String(e.message).slice(0, 120));
check('VRA anchor on chain matches the request', vra === true, `tx ${rec.request.transactionRef.toString().slice(0, 12)}...`);
check('VRA tx in record is the published VRA', rec.request.transactionRef.toString() === doc.anchors.vra);
const node = await VerifiablePresentationV1.verifyWithNode(rec.presentation, client, 'Testnet');
check('zero-knowledge presentation verifies with the node', node.type === 'success');
const pj = JSON.parse(JSON.stringify(rec.presentation.toJSON()));
const vc = pj.verifiableCredential?.[0];
const credId = /^did:ccd:testnet:cred:([0-9a-f]{96})$/.exec(vc?.credentialSubject?.id ?? '')?.[1];
const holder = credId ? (await client.getAccountInfo(CredentialRegistrationId.fromHexString(credId))).accountAddress.address : null;
check('credential holder account == published owner account', holder === doc.holderAccount, holder ?? '');
const st = vc?.credentialSubject?.statement ?? [];
check('statements: age range on dob + EU set on nationality', st.some(s => s.attributeTag === 'dob' && s.type === 'AttributeInRange') && st.some(s => s.attributeTag === 'nationality' && s.type === 'AttributeInSet'));
const pass = results.every(Boolean);
console.log(pass ? `ALL CHECKS PASS (${results.length}/${results.length})` : `FAILED (${results.filter(Boolean).length}/${results.length})`);
process.exit(pass ? 0 : 1);
