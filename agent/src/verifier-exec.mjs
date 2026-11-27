// Runs the keyless verifier (api/src/verify-payable-v2.mjs) in a clone of the repo, if one is next to this
// package. It needs no key and no env: it re-reads the chain and the invoice document. Returns the parsed result.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_API_DIR = resolve(HERE, '../../api');

export function parseVerifierOutput(text) {
  const all = /ALL CHECKS PASS \((\d+)\/(\d+)\)/.exec(text);
  if (all) return { pass: true, passed: Number(all[1]), total: Number(all[2]) };
  const part = /ALL RUNNABLE CHECKS PASS \((\d+)\/(\d+)/.exec(text);
  if (part) return { pass: false, passed: Number(part[1]), total: Number(part[2]), partial: true };
  const fail = /CHECKS FAILED \((\d+)\/(\d+)/.exec(text);
  if (fail) return { pass: false, passed: Number(fail[1]), total: Number(fail[2]) };
  return { pass: false, passed: null, total: null };
}

/** Build an `exec` function for tools.receipt (run_verifier=true). */
export function localVerifierExec({ apiBase, apiDir = REPO_API_DIR, timeoutMs = 240_000 } = {}) {
  return async function exec({ id, seller, commands }) {
    if (!existsSync(join(apiDir, 'src/verify-payable-v2.mjs')) || !existsSync(join(apiDir, 'node_modules'))) {
      return { ran: false, reason: 'No repo clone with installed dependencies next to this server. Run the command from the receipt in a clone of the public repo.' };
    }
    const dir = mkdtempSync(join(tmpdir(), 'payonce-verify-'));
    const docRes = await fetch(`${apiBase}/api/payables/${id}/document?seller=${seller}`);
    const docName = /--doc (\S+)/.exec(commands.run)[1];
    const docFile = join(dir, docName);
    writeFileSync(docFile, Buffer.from(await docRes.arrayBuffer()));
    const args = commands.run.replace(/^node /, '').split(' ').map((a) => (a === docName ? docFile : a));
    return await new Promise((res) => {
      execFile(process.execPath, args, { cwd: apiDir, timeout: timeoutMs, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, (err, stdout, stderr) => {
        const text = redact(`${stdout}\n${stderr}`);
        res({ ran: true, exit_code: err ? (err.code ?? 1) : 0, ...parseVerifierOutput(text), output_tail: text.trim().split('\n').slice(-14), command: commands.run });
      });
    });
  };
}
