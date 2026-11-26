// PayOnce API server — configuration (env-driven, testnet only).
// Every value that names the chain is a config value: the registry
// defaults to v2 <13150,0> and flips to the v2.1 instance by setting
// PAYONCE_REGISTRY_INDEX / PAYONCE_REGISTRY_MODULE (no code change).
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';

const env = { ...process.env };
for (const p of [
  process.env.PAYONCE_ENV_PATH,
  '/home/hatch/workspace/concordium-trusted-agents/.env',
  fileURLToPath(new URL('../.env', import.meta.url)),
].filter(Boolean)) {
  try {
    if (existsSync(p)) Object.assign(env, parseDotenv(readFileSync(p, 'utf8')));
  } catch { /* missing env file: read-only endpoints still work */ }
}

export const ENV = env;

export const NETWORK = 'testnet';
export const GRPC_HOST = env.PAYONCE_GRPC_HOST ?? 'grpc.testnet.concordium.com';
export const GRPC_PORT = Number(env.PAYONCE_GRPC_PORT ?? 20000);

export const REGISTRY = {
  index: Number(env.PAYONCE_REGISTRY_INDEX ?? 13150),
  subindex: Number(env.PAYONCE_REGISTRY_SUBINDEX ?? 0),
  moduleRef: (env.PAYONCE_REGISTRY_MODULE ?? 'c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8').toLowerCase(),
  name: env.PAYONCE_REGISTRY_NAME ?? 'payable_registry_v2',
};
export const CIS8004_OFFICIAL = {
  index: Number(env.PAYONCE_CIS8004_INDEX ?? 12802),
  subindex: Number(env.PAYONCE_CIS8004_SUBINDEX ?? 0),
  moduleRef: (env.PAYONCE_CIS8004_MODULE ?? '0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb').toLowerCase(),
  isOfficialRegistry: true,
};
export const RESERVATION_SECS = Number(env.PAYONCE_RESERVATION_SECS ?? 3600);
export const CO_SIGNER_MARGIN_SECS = 60;
export const OWNER_TOKEN = Number(env.PAYONCE_OWNER_TOKEN ?? 1476);

// Second seller (live 2026-11-25): identity 0 counter 0 of the same seed,
// agent token 1506 on the official registry <12802,0>, badge
// JyP9Y9nGU4KaM7DBDXRgm (badge_valid:true, 15/15). First payable id 1
// (0.5 CCD) paid by the demo payer; receipt verifier 10/10.
export const SELLER2_ADDRESS = env.PAYONCE_SELLER2 ?? '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';
export const SELLER2_TOKEN = Number(env.PAYONCE_SELLER2_TOKEN ?? 1506);
export const SELLER2_BADGE = env.PAYONCE_SELLER2_BADGE ?? 'JyP9Y9nGU4KaM7DBDXRgm';
export const SELLER2_AGENT_CARD_URL =
  env.PAYONCE_SELLER2_AGENT_CARD_URL ?? 'https://payonce-tau.vercel.app/.well-known/agent-card-seller2.json';

// Roles on v2 (proven live by the v2 E2E run 2026-11-24; seller 2 added 2026-11-25):
//   seller  = owner (holds the Active agent token 1476 on <12802,0>)
//   seller2 = second seller (holds the Active agent token 1506 on <12802,0>)
//   payer   = seller B (the demo payer; approves the seller, pays both rails)
//   payee   = per-invoice (payee1 for CCD, payee2 for EUDemo in the demo;
//             seller 2's own payables pay seller 2 itself)
export const OWNER_ADDRESS = env.PAYONCE_OWNER ?? '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
export const PAYER_ADDRESS = env.PAYONCE_PAYER ?? '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
export const PAYEE_CCD = env.PAYONCE_PAYEE_CCD ?? '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
export const PAYEE_EUDEMO = env.PAYONCE_PAYEE_EUDEMO ?? '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';

// Fresh-payable defaults (the demo entry point): small demo amounts on the
// same payees the v2 happy path used, due 24 h after registration.
export const FRESH_CCD_MICRO = BigInt(env.PAYONCE_FRESH_CCD_MICRO ?? 500_000); // 0.5 CCD
export const FRESH_EUDEMO_BASE = BigInt(env.PAYONCE_FRESH_EUDEMO_BASE ?? 10_000); // 0.01 EUDemo
export const FRESH_DUE_HOURS = Number(env.PAYONCE_FRESH_DUE_HOURS ?? 24);
export const FRESH_ID_START = Number(env.PAYONCE_FRESH_ID_START ?? 1000);

// Limits (P3 §16.2; operator-set values, enforced per IP).
export const LIMITS = {
  newInvoicesPerHour: Number(env.PAYONCE_NEW_INVOICES_PER_HOUR ?? 3),
  attemptsPerMinutePerIp: Number(env.PAYONCE_ATTEMPTS_PER_MINUTE_PER_IP ?? 10),
  attackSendsPerHour: Number(env.PAYONCE_ATTACK_SENDS_PER_HOUR ?? 3),
};

export const PORT = Number(env.PAYONCE_API_PORT ?? env.PORT ?? 7401);
export const HOST = env.PAYONCE_API_HOST ?? '127.0.0.1';
export const DATA_DIR = env.PAYONCE_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
export const ENV_PATH = env.PAYONCE_ENV_PATH ?? '/home/hatch/workspace/concordium-trusted-agents/.env';

export const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/';
export const EXPLORER_INSTANCE = 'https://ccdexplorer.io/testnet/instance/';
export const txUrl = (hash) => `${EXPLORER_TX}${hash}`;
export const instanceUrl = (index, subindex = 0) => `${EXPLORER_INSTANCE}${index}/${subindex}`;

export const fmtCcd = (micro) => `${(Number(micro) / 1e6).toFixed(6)} CCD`;
export const fmtEudemo = (base) => `${(Number(base) / 1e6).toFixed(2)} EUDemo`;
export const shortHash = (h) => (typeof h === 'string' && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h ?? '—');
