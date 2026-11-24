// PayOnce backend — D5 guard: enforceable proof that no LLM lives in the
// payment path.
//
// This is the guarantee behind the D5 decision, not a comment: it reads the
// actual payment-path source files as text and fails hard if any of them
// imports from src/invoice-adapter/ or contains an LLM-related string.
// It is exercised by test/invoice-adapter.test.mjs against the real files.
//
// Payment path covered (the files that decide / move money):
//   src/verifier/checks.mjs        CCD-12 / PLT-15 doc-hash checks
//   src/verifier/verify-payable.mjs
//   src/send.mjs                   transaction sender
//   src/cosigner/decide.mjs       co-signer decision gate
//   src/cosigner/snapshot.mjs     co-signer snapshot
//   src/cosigner/server.mjs       co-signer server
//   spikes/live-e2e.mjs           live end-to-end flow
// NOTE: this file itself, and src/invoice-adapter/adapter.mjs, legitimately
// contain these strings (they ARE the adapter + its guard) — that is why
// they are not in the checked list. Only the files above must be clean.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Payment-path files, as paths relative to the backend root. */
export const PAYMENT_PATH_RELATIVE = [
  'src/verifier/checks.mjs',
  'src/verifier/verify-payable.mjs',
  'src/send.mjs',
  'src/cosigner/decide.mjs',
  'src/cosigner/snapshot.mjs',
  'src/cosigner/server.mjs',
  'spikes/live-e2e.mjs',
];

/** Payment-path files as absolute paths (the default checked set). */
export const PAYMENT_PATH_FILES = PAYMENT_PATH_RELATIVE.map((rel) =>
  join(BACKEND_ROOT, rel),
);

/**
 * Forbidden strings (case-insensitive substring match). Any occurrence in a
 * payment-path file is a violation:
 *   - 'invoice-adapter' / 'invoicetextadapter': any import/use of the adapter
 *   - 'llm', 'openai', 'anthropic': any LLM provider reference
 */
export const FORBIDDEN_STRINGS = [
  'invoice-adapter',
  'invoicetextadapter',
  'llm',
  'openai',
  'anthropic',
];

/**
 * Static check: read each payment-path file as text and assert none of them
 * imports from src/invoice-adapter/ and none contains a forbidden string
 * (case-insensitive).
 *
 * @param {string[]} [files=PAYMENT_PATH_FILES] absolute paths, or paths
 *   relative to the backend root (a custom list is used by tests to prove
 *   the guard catches a tampered file).
 * @returns {{ ok: true, checked: string[], violations: [] }}
 * @throws {Error} listing every violation (file + matched string) when any
 *   file is dirty. A missing file also throws — a guard that silently skips
 *   a payment-path file would be worthless.
 */
export function assertNoLlmInPaymentPath(files = PAYMENT_PATH_FILES) {
  const checked = [];
  const violations = [];
  for (const file of files) {
    const abs = resolve(BACKEND_ROOT, file);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch (e) {
      throw new Error(
        `assertNoLlmInPaymentPath: cannot read payment-path file ${abs}: ${e.message}`,
      );
    }
    checked.push(abs);
    const lower = src.toLowerCase();
    for (const forbidden of FORBIDDEN_STRINGS) {
      if (lower.includes(forbidden)) {
        violations.push({ file: abs, pattern: forbidden });
      }
    }
  }
  if (violations.length > 0) {
    const lines = violations.map((v) => `  - ${v.file}: contains "${v.pattern}"`);
    throw new Error(
      `LLM FOUND IN PAYMENT PATH (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
  }
  return { ok: true, checked, violations: [] };
}
