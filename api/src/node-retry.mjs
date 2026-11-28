// Retry/backoff for READS on the public Concordium node, which answers HTTP 429 / UNAVAILABLE under load.
// Only a fixed list of read-only gRPC methods is ever retried. Anything else (sending a transaction, in particular)
// passes straight through with no retry: a payment of unknown status must never be repeated.
export const READ_METHODS = Object.freeze(new Set([
  'getAccountInfo', 'invokeContract', 'getInstanceInfo', 'getConsensusStatus', 'getBlockInfo', 'getBlockItemStatus',
  'getAccountBalance', 'getCryptographicParameters', 'getModuleSource', 'getEmbeddedSchema',
]));

const TRANSIENT = /\b429\b|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Too Many Requests|socket disconnected|No connection established|DEADLINE_EXCEEDED/i;
export const isTransient = (e) => TRANSIENT.test(`${e?.message ?? e} ${e?.code ?? ''} ${e?.details ?? ''}`);

/** Run an idempotent read with exponential backoff and jitter. Non-transient errors are thrown at once. */
export async function withRetry(fn, { tries = 5, baseMs = 500, maxMs = 6000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, onRetry } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === tries - 1) throw e;
      const wait = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + random() * 0.5);
      onRetry?.({ attempt: attempt + 1, wait, error: String(e?.message ?? e).slice(0, 120) });
      await sleep(wait);
    }
  }
  throw last;
}

/** A client whose read methods retry on transient node errors. Everything else is untouched. */
export function retryingReads(client, opts = {}) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (!READ_METHODS.has(String(prop))) return v.bind(target);
      return (...args) => withRetry(() => v.apply(target, args), opts);
    },
  });
}
