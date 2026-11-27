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
import { FRESH_ID_START, SELLER2_FRESH_ID_START } from './config.mjs';

// which = 1: seller 1 (counters.nextFreshId / freshIds); which = 2: seller 2
// (counters.nextFreshId2 / freshIds2, ids from SELLER2_FRESH_ID_START).
function fields(which) {
  return which === 2
    ? { next: 'nextFreshId2', ids: 'freshIds2', start: SELLER2_FRESH_ID_START }
    : { next: 'nextFreshId', ids: 'freshIds', start: FRESH_ID_START };
}

export async function allocateFreshId(which = 1) {
  const f = fields(which);
  return updateCounters((c) => {
    c[f.next] ??= f.start;
    const id = c[f.next];
    c[f.next] = id + 1;
    return id;
  });
}

/** Record an id that exists on chain (registered by us, or found there). */
export async function confirmFreshId(id, which = 1) {
  const f = fields(which);
  await updateCounters((c) => {
    const ids = new Set(c[f.ids] ?? []);
    ids.add(id);
    c[f.ids] = [...ids].sort((a, b) => a - b);
    c[f.next] = Math.max(c[f.next] ?? f.start, id + 1);
  });
}

/** Give an allocated id back when nothing was registered under it. */
export async function releaseFreshId(id, which = 1) {
  const f = fields(which);
  await updateCounters((c) => {
    if (c[f.next] === id + 1) c[f.next] = id;
  });
}

/** Fold ids discovered on chain into the counters (never lowers anything). */
export async function foldDiscoveredIds(ids, which = 1) {
  if (!ids.length) return;
  const f = fields(which);
  await updateCounters((c) => {
    const set = new Set(c[f.ids] ?? []);
    for (const id of ids) set.add(id);
    c[f.ids] = [...set].sort((a, b) => a - b);
    c[f.next] = Math.max(c[f.next] ?? f.start, ...ids.map((i) => i + 1));
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
export async function registerWithFreshId(trySend, { attempts = 8, which = 1, findFree = null } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const id = await allocateFreshId(which);
    let out;
    try {
      out = await trySend(id);
    } catch (e) {
      await releaseFreshId(id, which);
      throw e;
    }
    if (!out.rejected) {
      await confirmFreshId(id, which);
      return { id, ok: true, ...out };
    }
    last = { id, ok: false, ...out };
    if (out.rejected.code === -2) {
      // Duplicate: a payable with this id already exists on chain. Count it
      // (the stats scan must see it) and move to the next id.
      await confirmFreshId(id, which);
      // With a chain reader, jump past the whole run of existing ids at once instead of one by one.
      if (findFree) {
        const { free, existing } = await findFree(id + 1);
        await foldDiscoveredIds(existing, which);
        await updateCounters((c) => { const f = fields(which); c[f.next] = Math.max(c[f.next] ?? f.start, free); });
      }
      continue;
    }
    await releaseFreshId(id, which);
    return last;
  }
  return last;
}
