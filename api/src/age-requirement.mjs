// Which payables are age-gated (L2). Self-contained: the pay path imports this, never the agent package.
// A payable is gated when (a) its amount is at or above the ask-me threshold (1 CCD / 1.00 EUDemo), or
// (b) its registered invoice document states "Age restriction: 18+". The document is bound to the chain by its
// hash, so the seller cannot change the statement after registering, and no contract change is needed.

/** Minimum age stated in an invoice document, or null. */
export function docAgeRequirement(docText) {
  const m = /^Age restriction:\s*(\d{2})\+/im.exec(String(docText ?? ''));
  return m ? Number(m[1]) : null;
}

export function ageRequirement(view, docBytes) {
  let byAmount = false;
  try { byAmount = BigInt(view.amount) >= 1_000_000n; } catch { /* not a number: not gated by amount */ }
  const text = docBytes == null ? '' : Buffer.from(docBytes).toString('utf8');
  const minAge = docAgeRequirement(text);
  const byDoc = minAge != null && minAge >= 18;
  return {
    required: byAmount || byDoc,
    docGated: byDoc,
    reason: byDoc ? `the invoice document (bound to the chain by its hash) states "Age restriction: ${minAge}+"` : byAmount ? 'amount is at or above 1 CCD / 1.00 EUDemo' : null,
    source: byDoc ? 'document' : byAmount ? 'amount' : null,
    min_age: byDoc ? minAge : byAmount ? 18 : null,
  };
}
