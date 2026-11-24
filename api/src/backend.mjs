// PayOnce API server — backend resolution.
// The merged backend lives in the repo at backend/ (after the merge) and
// in the work tree at ~/workspace/payonce-build/backend/ (before it).
// This module finds it (env override first) and imports the pieces the
// API server reuses. Only PURE functions and read helpers are imported:
//   - v2 parsers + encoders + event decoders (registry-independent)
//   - decide() (pure co-signer decision)
//   - chain.mjs helpers (grpcClient, getTxStatus, getBlockTime, ...)
//   - receipt hash helpers (sha256Hex, canonicalJson, receiptIdFor, ...)
// Chain CALLS that name the registry go through ./chain-v2.mjs, which
// takes the registry from config (so the v2.1 switch is a config change,
// not a backend change). Sends go through ./chain-v2.mjs too, using the
// backend's sendUpdateV2/token-transfer shapes.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.PAYONCE_BACKEND_DIR,
  new URL('../../backend/', import.meta.url).pathname, // repo layout: api/ + backend/ siblings
  '/home/hatch/workspace/payonce/backend/',
  '/home/hatch/workspace/payonce-build/backend/',
];

export function resolveBackendDir() {
  for (const c of CANDIDATES) {
    if (!c) continue;
    const dir = c.endsWith('/') ? c : `${c}/`;
    if (existsSync(`${dir}src/chain.mjs`) && existsSync(`${dir}src/v2/registry.mjs`)) return dir;
  }
  throw new Error(
    'PayOnce backend not found. Set PAYONCE_BACKEND_DIR to the merged backend directory ' +
      '(the repo backend/ — it must contain src/chain.mjs and src/v2/registry.mjs).',
  );
}

export const BACKEND_DIR = resolveBackendDir();

async function imp(rel) {
  return import(pathToFileURL(`${BACKEND_DIR}${rel}`).href);
}

let cache = null;
/** Import the backend modules once; returns the bound namespace. */
export async function backend() {
  if (cache) return cache;
  const [chain, v2reg, v2enc, v2ev, v2send, decideMod, sendMod, receiptBuild, registryV1] = await Promise.all([
    imp('src/chain.mjs'),
    imp('src/v2/registry.mjs'),
    imp('src/v2/encoders.mjs'),
    imp('src/v2/events.mjs'),
    imp('src/v2/send.mjs'),
    imp('src/cosigner/decide.mjs'),
    imp('src/send.mjs'),
    imp('src/receipt/build.mjs'),
    imp('src/registry.mjs'),
  ]);
  cache = { chain, v2reg, v2enc, v2ev, v2send, decideMod, sendMod, receiptBuild, registryV1 };
  return cache;
}
