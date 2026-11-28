// Live progress of a /demo run, so the page can show transaction hashes as they land (about 3 minutes end to end).
// demo-run.mjs writes kv demo_run:progress after every transaction; GET /api/demo/run returns it while a run holds the lock.
const HASH = /^[0-9a-f]{64}$/i;

/** Labels in the order a visitor understands them. Keys are demo-run.mjs log.txs keys. */
export const PROGRESS_STEPS = [
  { key: 'bind', label: 'Payee bound' },
  { key: 'ack', label: 'Buyer agent acknowledged' },
  { key: 'register', label: 'Invoice registered' },
  { key: 'pay', label: 'Paid once' },
  { key: 'pay_again', label: 'Second payment refused' },
  { key: 'impostor_propose', label: 'Impostor proposed' },
  { key: 'impostor_accept', label: 'Impostor bound' },
  { key: 'impostor_register', label: 'Impostor invoice registered' },
  { key: 'impostor_pay', label: 'Impostor payment refused' },
];

/** The progress of the run that currently holds the lock, or null. Only valid hashes are passed on. */
export function progressFor({ lock, progress, now = Date.now() }) {
  if (!progress || !lock || !(lock.until_ms > now)) return null;
  if (lock.started_at && progress.started_at !== lock.started_at) return null;
  const txs = {};
  for (const s of PROGRESS_STEPS) if (HASH.test(String(progress.txs?.[s.key] ?? ''))) txs[s.key] = String(progress.txs[s.key]).toLowerCase();
  const steps = PROGRESS_STEPS.filter((s) => txs[s.key]).map((s) => ({ key: s.key, label: s.label, hash: txs[s.key] }));
  return { started_at: progress.started_at, at: progress.at ?? null, step: progress.step ?? null, steps };
}
