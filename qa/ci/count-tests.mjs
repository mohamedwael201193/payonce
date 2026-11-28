// Parse a test log into { label, tests, pass, fail } so the CI number is derived from what the runners printed, never typed.
//   node qa/ci/count-tests.mjs <label> <runner: node|vitest|cargo> <logfile> [outdir=counts]
// node --test (tap or spec summary), vitest ("Tests  N passed"), cargo ("test result: ok. N passed; M failed", summed over binaries).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export function parseLog(runner, text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (runner === 'node') {
    // Several `node --test` runs may be in one log (retry): the last complete summary wins.
    const re = /^(?:#|ℹ)\s+(tests|pass|fail)\s+(\d+)\s*$/gm; let m; let cur = {}; let last = null;
    while ((m = re.exec(clean))) { cur[m[1]] = Number(m[2]); if (m[1] === 'fail' || (m[1] === 'pass' && 'fail' in cur)) { /* keep going */ } if ('tests' in cur && 'pass' in cur && 'fail' in cur) { last = { ...cur }; cur = {}; } }
    return last ? { tests: last.tests, pass: last.pass, fail: last.fail } : null;
  }
  if (runner === 'vitest') {
    const m = /^\s*Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/m.exec(clean);
    return m ? { tests: Number(m[4]), pass: Number(m[2]), fail: Number(m[1] ?? 0) } : null;
  }
  if (runner === 'cargo') {
    let pass = 0; let fail = 0; let n = 0; const re = /test result: \w+\. (\d+) passed; (\d+) failed/g; let m;
    while ((m = re.exec(clean))) { pass += Number(m[1]); fail += Number(m[2]); n++; }
    return n ? { tests: pass + fail, pass, fail } : null;
  }
  throw new Error(`unknown runner ${runner}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [label, runner, file, out = 'counts'] = process.argv.slice(2);
  const r = parseLog(runner, readFileSync(file, 'utf8'));
  if (!r) { console.error(`no ${runner} summary found in ${file}`); process.exit(1); }
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/${label}.json`, JSON.stringify({ label, runner, ...r }) + '\n');
  console.log(`${label}: ${r.pass}/${r.tests} passing, ${r.fail} failing`);
}
