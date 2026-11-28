// CCDScan testnet GraphQL helpers. Used to recover an accept_payee hash for a bound account
// (the dashboard only stored it in the signing browser's localStorage).
export const CCDSCAN_GRAPHQL = 'https://api-ccdscan.testnet.concordium.com/api/graphql';

export function bookAsString(book) {
  if (!book) return null;
  if (typeof book === 'string') return book;
  const index = book.index ?? book.asString;
  const sub = book.subindex ?? book.subIndex ?? 0;
  if (typeof book === 'object' && book.asString && index == null) return book.asString;
  if (index == null || index === '') return typeof book.asString === 'string' ? book.asString : null;
  return `<${index},${sub}>`;
}

/** First successful accept_payee on `book` (or any book if book is omitted), from a CCDScan account-transactions payload. Newest first. */
export function pickAcceptPayeeTx(payload, book) {
  const want = bookAsString(book);
  const nodes = payload?.data?.accountByAddress?.transactions?.nodes ?? [];
  for (const n of nodes) {
    const tx = n?.transaction;
    const hash = tx?.transactionHash;
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) continue;
    const events = tx.result?.events?.nodes ?? [];
    for (const ev of events) {
      const name = ev?.receiveName;
      if (typeof name !== 'string' || !(name.endsWith('.accept_payee') || name === 'accept_payee')) continue;
      const addr = ev.contractAddress?.asString ?? bookAsString(ev.contractAddress);
      if (want && addr && addr !== want) continue;
      return hash;
    }
  }
  return null;
}

const QUERY = `query AcceptPayee($a: String!) {
  accountByAddress(accountAddress: $a) {
    transactions(first: 50) {
      nodes {
        transaction {
          transactionHash
          result { ... on Success { events { nodes { __typename ... on ContractUpdated { receiveName contractAddress { asString index subIndex } } } } } }
        }
      }
    }
  }
}`;

export function createCcdscan({ url = CCDSCAN_GRAPHQL, fetch: f = globalThis.fetch, timeoutMs = 2500 } = {}) {
  async function findAcceptPayeeTx(account, book) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { a: account } }),
        signal: ac.signal,
      });
      if (!res?.ok) return null;
      return pickAcceptPayeeTx(await res.json(), book);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  return { findAcceptPayeeTx };
}

/** Remember a found hash so /p and the dashboard do not depend on CCDScan being up every time. */
export function cachedBindTxFinder(find, kv) {
  return async (account, book) => {
    const key = `${account}:${bookAsString(book) ?? ''}`;
    const hit = await kv.get?.('payee_bind_tx', key).catch?.(() => null);
    if (hit?.tx_hash && /^[0-9a-f]{64}$/i.test(hit.tx_hash)) return hit.tx_hash;
    const h = await find(account, book);
    if (h && /^[0-9a-f]{64}$/i.test(h) && kv.put) await kv.put('payee_bind_tx', key, { tx_hash: h, at: new Date().toISOString() }).catch(() => {});
    return h ?? null;
  };
}
