// Copy deck — P3 §10 summary strings, and the binding copy rules of P3 §2.
// BANNED_WORDS is enforced by a vitest test (src/lib/copy.test.ts) that scans
// every user-visible string in this file. Add a new string here and the test
// will fail if it contains a banned claim.

// P3 §2 rule 3 — banned claims on screen, with the reason each is banned.
export const BANNED_WORDS: Array<{ word: string; reason: string }> = [
  { word: 'never pays a fake invoice', reason: 'false as an on-chain claim (VERDICT H1)' },
  { word: 'never pays the wrong account', reason: 'false as an on-chain claim (VERDICT H1)' },
  { word: 'escrow', reason: 'implies custody; Boris: no funds at rest' },
  { word: 'custody', reason: 'implies custody; the contract keeps no balance' },
  { word: 'held', reason: 'say "reserved" (Gate G0 #6)' },
  { word: 'stablecoin', reason: 'say "testnet demo token" (EUDemo is not a euro stablecoin)' },
  { word: 'mainnet', reason: 'testnet only; mainnet is never blurred with testnet' },
  { word: 'production', reason: 'this is a testnet demo, not production' },
  { word: 'audited', reason: 'no audit exists' },
  { word: 'secure', reason: 'unproven claim; say what was checked instead' },
  { word: 'instant', reason: 'only with a measured number' },
  { word: 'fully on-chain', reason: 'Rail B has a co-signer' },
  { word: 'Verified by Concordium', reason: 'only when badge.official === true (today it never is)' },
]

// P3 §2 rule 2 — "the chain refuses" only for a transaction the chain
// actually reverted. Co-signer refusals use this sentence.
export const COPY = {
  heroH1: 'Every invoice becomes a payable: an invoice on chain that can be paid exactly once, and only to the account the supplier put there.',
  heroSub:
    'Pay in CCD and the contract is the payment. On the EUDemo test token, a co-signed transfer makes the payment, and only after the chain has reserved the invoice.',
  testnetBadge: 'TESTNET',
  statsNoData: 'The testnet did not answer — live numbers are unavailable right now.',
  labPickerLabel: 'Lab invoices (testnet, not real)',
  step1Helper: 'Load a lab invoice, drop a file, or paste its text. Nothing is uploaded.',
  step2Helper: 'Read from the testnet registry and the seller’s agent. This step pays nothing.',
  step2VerdictReady: (payee: string) =>
    `All gating checks passed. The payee on chain is ${payee}. You can pay once.`,
  step3RailANote:
    'The payment comes from the demo payer account (a lab account). You sign nothing. This sends a real testnet transaction.',
  step3RailBNote:
    'Gas for the agent wallet is paid by the lab seller account. EUDemo is a testnet demo token, not real money.',
  paidCcd: (amount: string) =>
    `Paid once. The payee on chain received ${amount} in the same transaction.`,
  paidEudemo: (amount: string) =>
    `Paid once. Reserved, co-signed and confirmed. The payee on chain received ${amount} EUDemo.`,
  sellerAgent: 'Registered on a test CIS-8004 instance (official module, lab tokens).',
  sellerIdentity: 'Not verified. No company (LEI) or identity proof is attached to this seller.',
  badgeOfficial: 'Official Concordium badge',
  receiptFooter: 'Testnet receipt. It is not a legal invoice, a tax document or proof of delivery.',
  // N-6 (round-6 fix-back): name the verifier — this line is the
  // receipt (v1 after-pay) verifier, not the v2 CLI the Judges page
  // runs, so the two counts for the same payable are never confused
  // (payable 11 reads 15/15 here, 12/14 from the v2 CLI).
  verifierLine: (passed: number, total: number, time: string) =>
    `Receipt verifier: ${passed} of ${total} checks passed when we re-read the chain at ${time} UTC.`,
  buildStatusLine:
    'Build status loads live from /api/config — never a stale claim.',
  footer:
    'Testnet only. The lab keys sit on one machine. Details: For judges.',
  chainRefused: (code: number, name: string, plain: string, fee: string | null) =>
    `Refused by the chain (code ${code}, ${name}). ${plain} Nothing moved.${
      fee ? ` The chain still charged a fee of ${fee} testnet CCD.` : ''
    }`,
  coSignerRefused: (plain: string) =>
    `Refused by the co-signer before signing: ${plain} No transaction was sent.`,
  appRefused: (plain: string) =>
    `Refused by this app: ${plain} Nothing was sent to the chain.`,
  reserved: 'Reserved for this payment. The co-signer approved the reservation and the transfer.',
  labInvoiceLabel: 'Lab invoice (testnet, not a real invoice)',
  recordedRunLabel: 'Recorded run, 24 Nov 2026',
} as const

// One refused number, one basis, everywhere: the chain total since deploy
// (live, /api/stats) with the date of the last verifier run as the basis.
// The date is DERIVED from stats.last_verifier_run_at — never hardcoded:
// a hardcoded date goes stale on the next run and, worse, prints a date
// while the stats have not loaded at all (adversarial finding #6). While
// the stats have not loaded, the caption is EMPTY — the caller renders
// nothing date-like. Without a run date, the count stands alone.
export function refusedCaption(refusedOnChain: number | undefined, lastRunAt?: string | null): string {
  if (refusedOnChain === undefined) return ''
  const runDate = lastRunAt ? formatRunDate(lastRunAt) : null
  return runDate
    ? `Recorded run, ${runDate} · ${refusedOnChain} refused on chain since deploy`
    : `${refusedOnChain} refused on chain since deploy`
}

/** "2026-11-24T17:08:24.616Z" → "24 Nov 2026" (UTC). Null when unparseable. */
function formatRunDate(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// The build-status card used to print the raw config fragment ("Co-signer
// runs as: decision gate inside the API service (no service)") — a sentence
// no reader can parse. The co-signer runs in-process as a decision gate;
// no separate co-signer service exists.
export function coSignerRunsAsSentence(): string {
  return 'Decision gate inside the API service — no separate co-signer service runs.'
}

// Glossary (P3 §2 rule 15 + §16.13 item 8) — plain words first, technical
// term in brackets at first use on the page. Definitions use "reserved",
// never "held" (rule 3).
// The Reservation length is ONE number, read live from /api/config
// (reservation_secs: 3600 on the live chain — the old "300 s" was the
// v1-era value and contradicted step 01's live 3600 s, step 03 and this
// glossary, fix-back-6 B4). The static entry below is the live truth as a
// fallback; JudgesPage substitutes reservationDefinition(config) whenever
// /api/config has answered, so the glossary can never drift from the
// chain again.
export const GLOSSARY: Array<[string, string]> = [
  ['Payable', 'invoice on chain'],
  ['Reservation', 'the payable is reserved for one payer for 3600 s (60 minutes)'],
  ['Co-signer', 'second approver of the agent wallet'],
  ['Sponsor', 'pays the fee for a transaction'],
  ['Fingerprint', 'SHA-256 of the document bytes'],
  ['Verify & Pay', 'Concordium’s name for the flow: verify the seller and the invoice first, then pay once'],
  ['Consent anchor', 'a hash-bound owner approval recorded on chain before an above-threshold payment'],
  ['Fee peg', '€0.01 per transaction on Concordium'],
]

/** The Reservation glossary definition from the live config value. While
    config has not answered, no number is stated — a stale number is worse
    than a missing one. */
export function reservationDefinition(reservationSecs: number | undefined): string {
  if (reservationSecs === undefined) return 'the payable is reserved for one payer (reservation length loading…)'
  const minutes = reservationSecs % 60 === 0 ? ` (${reservationSecs / 60} minutes)` : ''
  return `the payable is reserved for one payer for ${reservationSecs} s${minutes}`
}

// Build status (fix-back-6 B5): a config value that has not loaded yet is
// "Loading…", never "Not yet (planned)" — the old ternary rendered the
// planned-state text on first paint, so a judge capturing first paint got
// the wrong answer for ~15 s while /api/config was still loading.
export function buildStatusText(loading: boolean, error: boolean, value: boolean | undefined): string {
  if (loading) return 'Loading…'
  if (error || value === undefined) return 'Could not load — the test API did not answer.'
  return value ? 'Yes' : 'Not yet (planned)'
}

/** Same loading rule for a build-status string value (e.g. "Confirm by"). */
export function buildStatusString(loading: boolean, error: boolean, value: string | undefined): string {
  if (loading) return 'Loading…'
  if (error || value === undefined) return 'Could not load — the test API did not answer.'
  return value
}

// Layer badges — P3 §2 rule 1: every refusal carries exactly one badge.
export const LAYER_LABEL: Record<string, string> = {
  chain: 'Chain',
  co_signer: 'Co-signer',
  app: 'This app',
  node: 'Node',
  server: 'Server',
}
