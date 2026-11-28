// Sum the per-suite counts that CI produced into the one published number.
//   node qa/ci/aggregate-tests.mjs <countsdir> <sha> <run_url>  ->  status/tests.json + status/tests-badge.json (shields endpoint format)
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function aggregate(rows, meta = {}) {
  const suites = rows.map((r) => ({ suite: r.label, runner: r.runner, tests: r.tests, pass: r.pass, fail: r.fail })).sort((a, b) => a.suite.localeCompare(b.suite));
  const tests = suites.reduce((n, s) => n + s.tests, 0); const pass = suites.reduce((n, s) => n + s.pass, 0); const fail = suites.reduce((n, s) => n + s.fail, 0);
  return { total: tests, passing: pass, failing: fail, skipped: tests - pass - fail, suites: suites.map((x) => ({ ...x, skipped: x.tests - x.pass - x.fail })), ...meta };
}
export const badge = (a) => ({ schemaVersion: 1, label: 'tests (CI)', message: a.failing ? `${a.passing}/${a.total} passing` : `${a.passing} passing${a.skipped ? `, ${a.skipped} skipped` : ''}`, color: a.failing ? 'red' : 'brightgreen' });

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, sha = '', runUrl = ''] = process.argv.slice(2);
  const rows = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (!rows.length) { console.error('no counts found'); process.exit(1); }
  const a = aggregate(rows, { commit: sha, run: runUrl, generated_at: new Date().toISOString(), source: 'parsed from the test runners\u2019 own summaries in the CI run above (node --test, vitest, cargo concordium test)' });
  mkdirSync('status', { recursive: true });
  writeFileSync('status/tests.json', JSON.stringify(a, null, 2) + '\n');
  writeFileSync('status/tests-badge.json', JSON.stringify(badge(a)) + '\n');
  console.log(`${a.passing}/${a.total} passing across ${a.suites.length} suites`);
}
