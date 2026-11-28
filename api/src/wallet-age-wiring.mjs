// Real adapters for wallet-age.mjs (testnet): anchored V1 request, node verification + VAA, official V0 verifier, holder lookup.
import { AccountAddress, VerificationRequestV1, VerificationAuditRecordV1, VerifiablePresentationV1, IdentityProviderDID, CredentialRegistrationId } from '@concordium/web-sdk';
import { vClient, verifyV1PresentationWithNode, assertContextsMatch, CONSENT_DOMAIN } from './consent.mjs';
import { retryBusy } from './age-v1.mjs';
import { VERIFIER_URL } from './age-proof.mjs';
import { signers, waitFinalized, grpc } from './chain-v2.mjs';
import { TESTNET_IDPS } from './payee-proof.mjs';

const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const refHex = (ref) => (ref?.toString?.() ?? String(ref ?? '')).toLowerCase();

export const ageWiring = {
  issuers: TESTNET_IDPS,
  async anchorV1Request({ account, seller_id, nonceHex }) {
    const { owner } = await signers();
    const sender = AccountAddress.fromBase58(owner.address);
    const context = VerificationRequestV1.createSimpleContext(new Uint8Array(Buffer.from(nonceHex, 'hex')), `payonce-age:${account}`, CONSENT_DOMAIN,
      `PayOnce 18+ check for ${seller_id}: account ${account} proves it is 18 or older; no attribute value is revealed`);
    const claims = VerificationRequestV1.claimsBuilder()
      .addAccountClaims(TESTNET_IDPS.map((i) => new IdentityProviderDID('Testnet', i)), (b) => b.addMinimumAge(18)).getClaims();
    const req = await retryBusy(() => VerificationRequestV1.createAndAnchor(vClient(), { sender, signer: owner.signer }, context, claims, { app: 'payonce-age-wallet', account }));
    const vra = refHex(req.transactionRef);
    await waitFinalized(await grpc(), vra);
    return { request: jsonSafe(req.toJSON()), vra_tx: vra };
  },
  async verifyV1({ request, presentation }) {
    let pres;
    try { pres = VerifiablePresentationV1.fromJSON(presentation); } catch { return { ok: false, reason: 'malformed V1 presentation' }; }
    let node = await verifyV1PresentationWithNode(pres);
    if (!node.ok && /429|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(node.reason)) { await new Promise((r) => setTimeout(r, 4000)); node = await verifyV1PresentationWithNode(pres); }
    if (!node.ok) return { ok: false, reason: node.reason };
    const req = VerificationRequestV1.fromJSON(request);
    try { assertContextsMatch(req, pres); } catch (e) { return { ok: false, reason: String(e?.message ?? e).slice(0, 200) }; }
    let vaa = null;
    try {
      const { owner } = await signers();
      const sender = AccountAddress.fromBase58(owner.address);
      const r = await retryBusy(() => VerificationAuditRecordV1.createAndAnchor(`payonce-age-wallet-${Date.now()}`, req, pres, vClient(), { metadata: { sender, signer: owner.signer }, info: { app: 'payonce-age-wallet' } }, { network: 'Testnet' }));
      if (r?.type === 'success') vaa = refHex(r.result?.anchorTransactionRef);
    } catch { /* the proof stands without the audit anchor */ }
    return { ok: true, vaa_tx: vaa };
  },
  async verifyV0({ presentation }) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await fetch(VERIFIER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(presentation), signal: ctl.signal });
      const text = await r.text();
      if (!r.ok) return { ok: false, reason: `verifier HTTP ${r.status}: ${text.slice(0, 160)}` };
      let j = {}; try { j = JSON.parse(text); } catch { /* ignore */ }
      return { ok: true, challenge: String(j.challenge ?? j.request?.challenge ?? '').toLowerCase() };
    } catch (e) { return { ok: false, reason: `verifier unreachable (${String(e?.message ?? e).slice(0, 80)})` }; } finally { clearTimeout(t); }
  },
  async holderAccount(credIdHex) {
    const info = await vClient().getAccountInfo(CredentialRegistrationId.fromHexString(credIdHex));
    return jsonSafe(info)?.accountAddress ?? null;
  },
};
