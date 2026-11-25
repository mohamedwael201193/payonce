// PayOnce API — CIS-8 external-key binding, build side only (workshops
// W2 §2.4, §2.6; W-17). Peter's story: "agents stay on their chain,
// Concordium adds accountability" — a CIS-8 entry links an external public
// key (Ethereum/Solana/200+ chains) to the Concordium account, and the
// agent registration references the CIS-8 entry.
//
// STATE (2026-11-25, honest): no CIS-8 binding exists for token 1476, and
// NO external key is held by the team. The lab's CIS-8 spikes used
// THROWAWAY keys only (secp256k1 generator pubkey, privkey=1 — a public
// test vector, no funds) to prove the MCP builders work; binding the
// seller token to a throwaway would link the agent to a key nobody owns,
// which proves nothing. So:
//   - the MCP build leg (build_cis8_canonical_bytes / build_cis8_register)
//     is implemented here and proven live against the hosted MCP;
//   - the SEND leg (external-key signature + CIS-8 register tx + attaching
//     `external_reference` to token 1476 + re-anchoring the card hash) is
//     implemented behind `requestCis8Binding`, which REFUSES without a real
//     external key supplied by the user (env PAYONCE_EXTERNAL_KEY_* or an
//     explicit call argument). No key is ever invented here.
//   - the badge stays fully valid (15/15) without a CIS-8 binding; this is
//     a missing cross-chain link, not a validity gap.
//
// The CIS-8 contract is <12801,0> (owner 3dt3UMPz… per the audit).
import { CIS8004_OFFICIAL } from './config.mjs';
import { mcpCallTool } from './mcp-client.mjs';

export const CIS8_CONTRACT = { index: 12801, subindex: 0 };
export const CIS8_SELLER_TOKEN = 1476;

/** A real external key, as the user must supply it. Nothing here generates one. */
export function externalKeyFromEnv(env = process.env) {
  const namespace = env.PAYONCE_EXTERNAL_KEY_NAMESPACE ?? null;
  const keyType = env.PAYONCE_EXTERNAL_KEY_TYPE ?? null;
  const publicKeyHex = env.PAYONCE_EXTERNAL_KEY_HEX ?? null;
  if (!namespace || !keyType || !publicKeyHex) return null;
  if (!/^[0-9a-fA-F]+$/.test(publicKeyHex)) return null;
  return { namespace, key_type: keyType, public_key_hex: publicKeyHex.toLowerCase() };
}

/**
 * Ask the MCP to build the exact canonical bytes an external key must sign
 * for a CIS-8 binding. Read-only (builders only, no send). `key` must be a
 * real held key; tests use the documented throwaway test vector and never
 * send anything.
 */
export async function buildCis8CanonicalBytes({ key, concordiumAccount, network = 'testnet', fetchImpl = fetch } = {}) {
  if (!key?.namespace || !key?.key_type || !key?.public_key_hex) {
    throw new Error('buildCis8CanonicalBytes: key { namespace, key_type, public_key_hex } is required');
  }
  const { message } = await mcpCallTool({
    name: 'build_cis8_canonical_bytes',
    arguments: { network, concordium_account: concordiumAccount, key },
    network,
    fetchImpl,
  });
  const text = message?.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* text form */ }
  return { raw: text, parsed, key };
}

/**
 * Ask the MCP to build the sign-ready CIS-8 register payload for a signed
 * canonical-bytes proof. Read-only (no send). `proof` = { scheme,
 * signature_hex } from the external key's owner signing the canonical
 * bytes with the scheme the MCP named (e.g. ethereum-personal-sign).
 */
export async function buildCis8Register({ key, proof, sender, network = 'testnet', fetchImpl = fetch } = {}) {
  if (!key?.namespace || !key?.key_type || !key?.public_key_hex) {
    throw new Error('buildCis8Register: key { namespace, key_type, public_key_hex } is required');
  }
  if (!proof?.scheme || !proof?.signature_hex) {
    throw new Error('buildCis8Register: proof { scheme, signature_hex } from the external key owner is required');
  }
  if (!sender) throw new Error('buildCis8Register: sender (Concordium account) is required');
  const { message } = await mcpCallTool({
    name: 'build_cis8_register',
    arguments: { network, sender, external_key: key, proof },
    network,
    fetchImpl,
  });
  const text = message?.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* text form */ }
  return { raw: text, parsed, key, sender };
}

/**
 * The full binding request. REFUSES (throws) when no real external key is
 * held: the send leg cannot run without the external key owner's signature,
 * and inventing a key would bind the seller token to a key nobody owns.
 * With a key + proof, returns the MCP-built register payload for the
 * caller to send (the send itself + the external_reference attach + the
 * card re-anchor are the remaining steps, recorded in the fix-back report).
 */
export async function requestCis8Binding({ key = null, proof = null, sender, env = process.env, fetchImpl = fetch } = {}) {
  const held = key ?? externalKeyFromEnv(env);
  if (!held) {
    throw new Error(
      'requestCis8Binding: BLOCKED — no external key is held (env PAYONCE_EXTERNAL_KEY_NAMESPACE / _TYPE / _HEX unset, no key argument). '
      + 'The user must supply or generate a real external key (e.g. an Ethereum key the team holds) and sign the MCP canonical bytes with it. '
      + 'No key is invented here: binding token 1476 to a throwaway would link the agent to a key nobody owns.',
    );
  }
  if (!proof) {
    const canonical = await buildCis8CanonicalBytes({ key: held, concordiumAccount: sender, fetchImpl });
    return { status: 'awaiting_external_signature', key: held, canonicalBytes: canonical.parsed ?? canonical.raw, next: 'sign the canonical bytes with the external key (scheme named by the MCP), then call requestCis8Binding again with proof { scheme, signature_hex }' };
  }
  const register = await buildCis8Register({ key: held, proof, sender, fetchImpl });
  return { status: 'register_payload_built', key: held, register: register.parsed ?? register.raw, next: 'send the register payload to CIS-8 <12801,0>, then attach external_reference to token 1476 and re-anchor the card hash' };
}

/** The seller token a CIS-8 binding would attach to. */
export const CIS8_BINDING_TARGET = { tokenId: CIS8_SELLER_TOKEN, registry: CIS8004_OFFICIAL };
