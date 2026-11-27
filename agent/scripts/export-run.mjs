#!/usr/bin/env node
// Trim an agent run record (qa/out/agent-run-<date>.json) into the file the app bundles as its recorded run
// (frontend/src/app/data/agentRun.json). It drops the bulky raw tool results; every decision, check, transaction
// hash and verifier result is kept. The full record stays in qa/out.
//
//   node agent/scripts/export-run.mjs <run.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , input, outArg] = process.argv;
if (!input) { console.error('usage: export-run.mjs <run.json> [out.json]'); process.exit(2); }
const HERE = dirname(fileURLToPath(import.meta.url));
const out = resolve(outArg ?? resolve(HERE, '../../frontend/src/app/data/agentRun.json'));
const run = JSON.parse(readFileSync(input, 'utf8'));

export function trimRun(r) {
  return {
    ...r,
    decisions: r.decisions.map(({ steps, ...d }) => ({ ...d, verifier_run: d.verifier_run ? { ran: d.verifier_run.ran, pass: d.verifier_run.pass, passed: d.verifier_run.passed, total: d.verifier_run.total, command: d.verifier_run.command } : null })),
    transcript: r.transcript.map(({ result, args, ...e }) => e),
  };
}

writeFileSync(out, JSON.stringify(trimRun(run), null, 1) + '\n');
console.log(`wrote ${out}`);
