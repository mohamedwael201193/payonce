// Small shared helpers for the PayOnce agent track. No dependencies.
import { createHash } from 'node:crypto';

export const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Concordium account addresses (base58, 50 chars, start with 2-4 on testnet and mainnet alike). */
export const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{50}\b/g;
export function addressesIn(text) {
  return [...new Set(String(text ?? '').match(ADDRESS_RE) ?? [])];
}

/**
 * Redaction for anything that is printed, logged or recorded. Removes exact
 * secret values (API keys, tokens, seeds passed in `secrets`), bearer tokens,
 * Anthropic-style keys, and runs of 12+ lower-case words (a seed phrase).
 * It deliberately does NOT touch 64-hex strings: transaction hashes are public
 * and are the proof this track records.
 */
export function redact(input, secrets = []) {
  let s = String(input ?? '');
  for (const x of secrets) if (typeof x === 'string' && x.length >= 6) s = s.split(x).join('[REDACTED]');
  s = s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED-KEY]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  s = s.replace(/(?:\b[a-z]{3,10}\b[\s,;:]+){11,}\b[a-z]{3,10}\b/g, '[REDACTED-WORDS]');
  return s;
}

/** Error text that cannot leak: message only, redacted, bounded. SDK error objects are never serialised. */
export function safeError(e, secrets = []) {
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return `${name}: ${redact(e?.message ?? e, secrets)}`.slice(0, 400);
}

/** Secret values worth redacting from the process environment (never printed, only matched). */
export function envSecrets(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.length >= 8 && /key|token|seed|secret|private|phrase|password/i.test(k)) out.push(v);
  }
  return out;
}

export const microToDisplay = (base, asset) => `${(Number(base) / 1e6).toFixed(asset === 'CCD' || asset === 'ccd' ? 6 : 2)} ${asset === 'CCD' || asset === 'ccd' ? 'CCD' : 'EUDemo'}`;
