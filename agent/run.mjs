#!/usr/bin/env node
// Run the PayOnce agent once against an API and write qa/out/agent-run-<date>.json.
//
//   node agent/run.mjs [--api <url>] [--out <file>] [--scripted] [--no-exec-verifier]
//
// Real testnet payments (dust). Secrets are only ever read from the environment in-process, never printed.
// ANTHROPIC_API_KEY (optional) selects the Claude planner; without it the labelled scripted planner runs.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { runScenario } from './src/scenario.mjs';
import { localVerifierExec } from './src/verifier-exec.mjs';
import { ScriptedPlanner } from './src/planners.mjs';
import { redact, envSecrets, safeError } from './src/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

// Optional env file (never printed): PAYONCE_AGENT_ENV_FILE=/path/to/.env supplies ANTHROPIC_API_KEY if present there.
const env = { ...process.env };
if (env.PAYONCE_AGENT_ENV_FILE && existsSync(env.PAYONCE_AGENT_ENV_FILE)) {
  const parsed = parseEnv(readFileSync(env.PAYONCE_AGENT_ENV_FILE, 'utf8'));
  if (parsed.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
}

const apiUrl = opt('--api', env.PAYONCE_API_URL || 'https://payonce-api-n98a.onrender.com');
const date = new Date().toISOString().slice(0, 10);
const out = resolve(opt('--out', resolve(HERE, `../qa/out/agent-run-${date}.json`)));
const exec = flag('--no-exec-verifier') ? null : localVerifierExec({ apiBase: apiUrl });

try {
  const record = await runScenario({
    apiUrl, env, exec,
    planner: flag('--scripted') ? new ScriptedPlanner() : null,
    headers: { 'x-payonce-run': 'test' },
    log: (l) => process.stdout.write(redact(l, envSecrets(env)) + '\n'),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  process.stdout.write(`\nplanner: ${record.planner.label}\npaid ${record.totals.paid}, refused ${record.totals.refused}, held ${record.totals.held}\nwrote ${out}\n`);
} catch (e) {
  process.stderr.write(`agent run failed: ${safeError(e, envSecrets(env))}\n`);
  process.exit(1);
}
