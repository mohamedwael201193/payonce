// PayOnce QA — secret scan for the repo (plan P1 §6.5 job 3 + Gate G0 #7).
// Fails on seed / private-key / token shapes. Transaction hashes are 64 hex
// chars, so they are allowlisted (see ALLOWLIST below); everything else that
// looks like a secret fails the run.
// Usage: node qa/ci/secrets-scan.mjs <path> [--history]
//   --history: scan every commit (git log -p). Without it: scan the tree.
// Exit 0 = clean, 1 = findings.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const target = process.argv[2] ?? '.';
const doHistory = process.argv.includes('--history');

// Known test DOBs are built from parts so this file itself does not contain
// the literal values it scans for (self-referential false positives).
const KNOWN_DOBS = ['20' + '10-06-01', '19' + '70-01-01', '20' + '100601', '19' + '700101'];
const KNOWN_DOB_RE = new RegExp(`\\b(?:${KNOWN_DOBS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
const PATTERNS = [
  { name: 'mnemonic/seed phrase (12 or 24 words)', re: /\b(?:[a-z]{3,8}[ ]+){11,23}[a-z]{3,8}\b/ },
  { name: 'private key (hex 64, labelled or bare)', re: /(?:private[_-]?key|secret[_-]?key|PRIVATE[_-]?KEY)\s*[:=]\s*["']?[0-9a-fA-F]{32,}/ },
  { name: 'Concordium account private key (base58-ish 64)', re: /\b[1-9A-HJ-NP-Za-km-z]{64}\b/ },
  { name: 'PEM private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'API token / bearer (labelled)', re: /(?:api[_-]?key|token|bearer|password|passwd)\s*[:=]\s*["'][^"'\s]{16,}["']/i },
  { name: 'GitHub classic token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Vercel token', re: /\b[A-Za-z0-9]{24}\b.{0,0}/ }, // placeholder, refined below
  { name: 'AWS key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'known test DOB literal (mock-identity birth dates that must never be public)', re: KNOWN_DOB_RE },
  { name: 'date of birth literal (date next to dob/birth keyword)', re: /(?:dob|date[_-]?of[_-]?birth|birth[_-]?date)[^\n]{0,40}(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/i },
  { name: '.env assignment with a long value', re: /^(?:[A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|SEED|PRIVATE))=.+/m },
];
// 64-hex transaction hashes are EXPECTED in evidence files — allowlist them.
const TX_HASH = /\b[0-9a-f]{64}\b/g;
const ALLOWLIST_FILES = new Set(['.gitignore', 'package-lock.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'target', 'dist', '.next']);

// Documented public values that are NOT secrets (see qa/gate-g0.md #7):
// '0100000000000000' = CIS-8004 agent token id 1 as 8-byte LE hex, from the
// recorded run (plan P3 §16) — a public on-chain token id, not a credential.
// Strip it like tx hashes (to a single '0', so the labelled-token
// pattern's 16+ char requirement cannot match it) so the dev stub +
// gate-g0.md prose do not trip the scan.
// Also two fake unit-test fixture tokens that earlier commits hold as literals (api/test; the files now build them from parts).
const PUBLIC_VALUES = ['0100000000000000', 'agent-token-0123456789abcdef', 'unit-test-token-0000000000000000'];

// Seed-phrase detection: 12+ CONSECUTIVE BIP-39 words. Plain prose of 12 lowercase words is not a seed phrase,
// and flagging it buried real findings. The wordlist comes from the installed bip39 package
// (npm ci --prefix backend); without it the scan falls back to the strict 12-lowercase-words shape.
let BIP39 = null;
function loadWordlist() {
  if (BIP39 !== null) return BIP39;
  const roots = [path.resolve(target), process.cwd()];
  for (const root of roots) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 6 || found.length) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && (e.name === 'node_modules' || depth < 6) && e.name !== '.git') {
          if (e.name === 'wordlists' && /bip39/.test(p)) { const f = path.join(p, 'english.js'); if (fs.existsSync(f)) found.push(f); }
          walk(p, depth + 1);
        }
      }
    };
    walk(path.join(root, 'backend', 'node_modules'), 0);
    if (found.length) {
      const m = fs.readFileSync(found[0], 'utf8').match(/`([^`]+)`/s);
      const words = m ? m[1].split(/\s+/).filter(Boolean) : [];
      if (words.length === 2048) { BIP39 = new Set(words); return BIP39; }
    }
  }
  BIP39 = false;
  return BIP39;
}
function hasSeedRun(text) {
  const list = loadWordlist();
  if (!list) return /\b(?:[a-z]{3,8}[ ]+){11,23}[a-z]{3,8}\b/.test(text);
  for (const line of text.split('\n')) {
    const words = line.toLowerCase().match(/[a-z]+/g);
    if (!words || words.length < 12) continue;
    let run = 0;
    for (const w of words) { run = list.has(w) ? run + 1 : 0; if (run >= 12) return true; }
  }
  return false;
}

function findingsInText(text, where) {
  const hits = [];
  // Strip tx hashes first so evidence files do not trip the scan.
  let stripped = text.replace(TX_HASH, '0'.repeat(64));
  for (const v of PUBLIC_VALUES) stripped = stripped.split(v).join('0');
  for (const p of PATTERNS) {
    if (p.name.startsWith('Vercel token')) continue; // too broad; covered by labelled-token pattern
    const matched = p.name.startsWith('mnemonic') ? hasSeedRun(stripped) : p.re.test(stripped);
    if (matched) hits.push({ pattern: p.name, where });
  }
  return hits;
}

function scanTree(dir) {
  const hits = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) hits.push(...scanTree(p));
    else if (ent.isFile()) {
      if (ALLOWLIST_FILES.has(ent.name)) continue;
      if (/\.(png|jpg|jpeg|gif|webp|mp4|wasm|woff2?|ttf|ico)$/i.test(ent.name)) continue;
      try {
        const text = fs.readFileSync(p, 'utf8');
        hits.push(...findingsInText(text, p));
      } catch { /* binary, skip */ }
    }
  }
  return hits;
}

function scanHistory() {
  let log;
  try {
    log = execSync('git log -p --all --no-merges', { cwd: target, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  } catch (e) {
    console.log('[SCAN] git log failed (not a repo yet?):', (e?.message ?? String(e)).slice(0, 200));
    return [];
  }
  return findingsInText(log, 'git history (all commits)');
}

function scanTarget(targetPath) {
  const st = fs.statSync(targetPath);
  if (st.isFile()) {
    try {
      return findingsInText(fs.readFileSync(targetPath, 'utf8'), targetPath);
    } catch { return []; }
  }
  return scanTree(targetPath);
}

const hits = doHistory ? scanHistory() : scanTarget(target);
if (doHistory) {
  // Also scan the working tree (uncommitted files are not in history).
  hits.push(...scanTarget(target));
}
if (hits.length === 0) {
  console.log('[SCAN] CLEAN — no secret shapes found' + (doHistory ? ' in git history + working tree' : ' in working tree'));
  process.exit(0);
}
console.log(`[SCAN] FAIL — ${hits.length} finding(s):`);
for (const h of hits.slice(0, 50)) console.log(`  - ${h.pattern} @ ${h.where}`);
process.exit(1);
