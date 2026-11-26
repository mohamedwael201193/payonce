// PayOnce API server — fresh payable id allocation (testnet only).
//
// Why this module exists: handleCreatePayable used to read
// counters.nextFreshId at the start, wait ~30-60 s for the registration to
// finalize, and then save its stale copy of the whole counters document.
// Two concurrent creates got the same id (chain Duplicate -2), and a verify
// run saving in between could move nextFreshId BACKWARDS, so every later
// create hit Duplicate too (seen live 2026-11-26: payables 1050-1052 existed
// on chain while the server's counter said 1050 and POST /api/payables
// answered 409 Duplicate every time). Now:
//   - an id is ALLOCATED atomically (updateCounters queue) before the send,
//   - a chain Duplicate means "that id exists": it is counted and the next id
//     is tried (bounded),
//   - a failed send releases the id again so no hole is left behind,
//   - ids found on chain beyond the counter are folded back in (discovery).
import { updateCounters } from './store.mjs';

export async function allocateFreshId() {
  return updateCounters((c) => {
    const id = c.nextFreshId;
    c.nextFreshId = id + 1;
    return id;
  });
}

/** Record an id that exists on chain (registered by us, or found there). */
export async function confirmFreshId(id) {
  await updateCounters((c) => {
    const ids = new Set(c.freshIds ?? []);
    ids.add(id);
    c.freshIds = [...ids].sort((a, b) => a - b);
    c.nextFreshId = Math.max(c.nextFreshId, id + 1);
  });
}

/** Give an allocated id back when nothing was registered under it. */
export async function releaseFreshId(id) {
  await updateCounters((c) => {
    if (c.nextFreshId === id + 1) c.nextFreshId = id;
  });
}

/** Fold ids discovered on chain into the counters (never lowers anything). */
export async function foldDiscoveredIds(ids) {
  if (!ids.length) return;
  await updateCounters((c) => {
    const set = new Set(c.freshIds ?? []);
    for (const id of ids) set.add(id);
    c.freshIds = [...set].sort((a, b) => a - b);
    c.nextFreshId = Math.max(c.nextFreshId, ...ids.map((i) => i + 1));
  });
}

/**
 * Register a payable under a freshly allocated id.
 * `trySend(id)` must send + await finality and return
 *   { txHash, rejected: null | { code, name, ... }, ...extra }
 * (or throw for a transport failure: the id is released and the error is
 * rethrown). Returns { id, ok: true, ...out } on success, or
 * { id, ok: false, ...out } for a non-duplicate refusal or `attempts`
 * duplicates in a row.
 */
export async function registerWithFreshId(trySend, { attempts = 8 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const id = await allocateFreshId();
    let out;
    try {
      out = await trySend(id);
    } catch (e) {
      await releaseFreshId(id);
      throw e;
    }
    if (!out.rejected) {
      await confirmFreshId(id);
      return { id, ok: true, ...out };
    }
    last = { id, ok: false, ...out };
    if (out.rejected.code === -2) {
      // Duplicate: a payable with this id already exists on chain. Count it
      // (the stats scan must see it) and move to the next id.
      await confirmFreshId(id);
      continue;
    }
    await releaseFreshId(id);
    return last;
  }
  return last;
}
