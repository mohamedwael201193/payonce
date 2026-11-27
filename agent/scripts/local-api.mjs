#!/usr/bin/env node
// Start a LOCAL PayOnce API (testnet) with wallet keys taken in-process from an env file.
//
//   node agent/scripts/local-api.mjs --env D:\path\to\.env [--port 7411]
//
// The file may use the standard names (CONCORDIUM_WALLET_SEED_PHRASE, CONCORDIUM_WALLET_PRIVATE_KEY) or the
// short names seed_phares / private_key. Values go straight into the child process environment; they are never
// printed, logged or written. Child output is passed through a redactor.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { redact } from '../src/util.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', process.env.PAYONCE_ENV_FILE);
if (!envFile) { console.error('usage: local-api.mjs --env <file> [--port N]'); process.exit(2); }
const port = opt('--port', '7411');
const file = parseEnv(readFileSync(envFile, 'utf8'));
const seed = file.CONCORDIUM_WALLET_SEED_PHRASE ?? file.seed_phares ?? file.seed_phrase;
const key = file.CONCORDIUM_WALLET_PRIVATE_KEY ?? file.private_key;
if (!seed || !key) { console.error('env file has no wallet seed / private key'); process.exit(2); }
const secrets = [seed, key];

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../api');
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: apiDir,
  env: {
    ...process.env,
    CONCORDIUM_WALLET_SEED_PHRASE: seed,
    CONCORDIUM_WALLET_PRIVATE_KEY: key,
    PAYONCE_API_PORT: port,
    PAYONCE_DATA_DIR: process.env.PAYONCE_DATA_DIR ?? resolve(apiDir, `data-local-${port}`),
    PAYONCE_SKIP_RECONCILE: '1',
    PAYONCE_NEW_INVOICES_PER_HOUR: process.env.PAYONCE_NEW_INVOICES_PER_HOUR ?? '30',
    PAYONCE_ATTEMPTS_PER_MINUTE_PER_IP: process.env.PAYONCE_ATTEMPTS_PER_MINUTE_PER_IP ?? '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => process.stdout.write(redact(d.toString(), secrets)));
child.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGINT', () => child.kill());
