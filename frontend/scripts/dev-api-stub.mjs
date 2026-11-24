// DEV-ONLY API stub — implements the P3 §16 contract on port 7401.
// It is NEVER part of the production build (scripts/ is not imported by the
// app; vite only proxies /api to it in dev). It NEVER sends a transaction.
//
// Data provenance (read this before trusting any value):
// - Payee / seller / amounts / due dates / statuses / payment tx hashes:
//   a LIVE snapshot of contract <13149,0> read by me via gRPC on 24 Nov 2026
//   (get_payable views 1–5 + getInstanceInfo; registry balance 0 microCCD).
//   Payable 2/3 due dates match P3 §16 exactly, which validates the decode.
// - doc_sha256: the SHA-256 of THIS stub's own lab documents (computed at
//   startup), so the browser fingerprint check runs for real. The on-chain
//   doc_hashes are different (they hash Claude's lab documents, which are not
//   in this workspace). The mechanism — hash comparison — is genuinely exercised.
// - Attacks / recorded runs: the REAL recorded results from P3 §9/§16.12/§17
//   (real tx hashes, real fees), returned with live:false and labelled
//   "Recorded run, 24 Nov 2026".
// - POST /pay and POST /payables (fresh invoice) are NOT implemented here:
//   the stub never sends a transaction. They return an honest error envelope.
//   The pay timeline UI is exercised via the recorded run + unit tests, and
//   live-verified against the real backend when it lands.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = 7401
const SNAPSHOT_AT = '2026-11-24T07:15:00Z' // UTC; gRPC snapshot time
const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/'
const EXPLORER_INST = 'https://ccdexplorer.io/testnet/instance/'

const SELLER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs'
const PAYEE_CCD = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin'
const PAYEE_EUDEMO = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg'
const PAYER_EUDEMO = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n'
const PAYER_CCD = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function labDoc(id, asset, amountDisplay, payee) {
  return [
    'Lab invoice (testnet, not a real invoice)',
    `Payable ${id}`,
    `Amount: ${amountDisplay}`,
    `Payee (on chain, not in this text): ${payee}`,
    `Seller: ${SELLER}`,
    'Asset: ' + (asset === 'ccd' ? 'CCD (testnet)' : 'EUDemo (testnet demo token, not a euro stablecoin)'),
    'Due: 25 Nov 2026',
    'This document is evidence only. The payee is read from the chain.',
  ].join('\n')
}

// Live snapshot of <13149,0> (24 Nov 2026). Statuses per P3 §18:
// payables 1 and 4 are paid (CCD); payable 2 is paid (EUDemo);
// payables 3 and 5 are unpaid EUDemo invoices.
const PAYABLES = [
  {
    payable_id: 1, asset: 'ccd', amount: '500000', amount_display: '0.5 CCD',
    payee: PAYEE_CCD, seller: SELLER, due: '2026-11-25T04:49:23.985Z',
    status: { kind: 'paid', payer: PAYER_CCD, paid_at: '2026-11-24T04:50:00Z', payment_tx: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6', payment_tx_source: 'server_store' },
  },
  {
    payable_id: 2, asset: 'eudemo', amount: '10000', amount_display: '0.01 EUDemo',
    payee: PAYEE_EUDEMO, seller: SELLER, due: '2026-11-25T04:49:31.426Z',
    status: { kind: 'paid', payer: PAYER_EUDEMO, paid_at: '2026-11-24T04:50:00Z', payment_tx: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', payment_tx_source: 'chain' },
  },
  {
    payable_id: 3, asset: 'eudemo', amount: '10000', amount_display: '0.01 EUDemo',
    payee: PAYEE_EUDEMO, seller: SELLER, due: '2026-11-25T04:49:45.521Z',
    status: { kind: 'unpaid' },
  },
  {
    payable_id: 4, asset: 'ccd', amount: '500000', amount_display: '0.5 CCD',
    payee: PAYEE_CCD, seller: SELLER, due: '2026-11-25T04:49:39.472Z',
    status: { kind: 'paid', payer: PAYER_CCD, paid_at: '2026-11-24T04:51:00Z', payment_tx: '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e', payment_tx_source: 'server_store' },
  },
  {
    payable_id: 5, asset: 'eudemo', amount: '10000', amount_display: '0.01 EUDemo',
    payee: PAYEE_EUDEMO, seller: SELLER, due: '2026-11-25T04:49:53.537Z',
    status: { kind: 'unpaid' },
  },
]

for (const p of PAYABLES) {
  p.document = labDoc(p.payable_id, p.asset, p.amount_display, p.payee)
  p.doc_sha256 = sha256(p.document)
}

const CONFIG = {
  network: 'testnet',
  registry: { index: 13149, subindex: 0, module_ref: '9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24' },
  cis8004_test_instance: { index: 13144, subindex: 0, official_module_ref: '0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb', is_official_registry: false },
  reservation_secs: 300,
  co_signer_margin_secs: 60,
  assets: {
    ccd: { decimals: 6, label: 'CCD (testnet)' },
    eudemo: { decimals: 6, label: 'EUDemo (testnet demo token, not a euro stablecoin)' },
  },
  payer_label: 'Demo payer account (lab)',
  sponsor_label: 'Lab seller account (pays agent-wallet gas)',
  explorer: { tx: EXPLORER_TX, instance: EXPLORER_INST },
  vendor_list: [{ seller: SELLER, label: 'Lab seller (grocer, lab account)' }],
  build: {
    vendor_list_enforced_by_co_signer: false,
    named_payer_on_invoice: false,
    confirm_by: 'payer_or_seller',
    header_expiry_bound: false,
    co_signer_runs_as: 'in_process_lab',
  },
  limits: { new_invoices_per_hour: 3, attempts_per_minute_per_ip: 10 },
  verifier: { file: 'verify-payable.mjs', version_date: '2026-11-24' },
  as_of: SNAPSHOT_AT,
}

const HEALTH = {
  chain: { reachable: true, checked_at: SNAPSHOT_AT },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 10 },
}

function stats() {
  const paid = PAYABLES.filter((p) => p.status.kind === 'paid').length
  return {
    payables_total: PAYABLES.length,
    paid_total: paid,
    // Chain refusals observed in the recorded run: -5, -6, -3, -16, -12, -17, -13.
    refused_on_chain_since_deploy: 7,
    last_verifier_run_at: '2026-11-24T10:42:07Z',
  }
}

function payableView(p) {
  return {
    payable_id: p.payable_id,
    asset: { kind: p.asset, token: p.asset === 'ccd' ? 'CCD' : 'EUDemo' },
    amount: p.amount,
    amount_display: p.amount_display,
    payee: p.payee,
    seller: p.seller,
    due: p.due,
    is_past_due: new Date(p.due).getTime() < Date.now(),
    status: p.status,
    agent: { registry: { index: 13144, subindex: 0 }, token: '0100000000000000' },
    doc_sha256: p.doc_sha256,
    label: 'Lab invoice (testnet, not a real invoice)',
  }
}

function checksBefore(p, docSha256) {
  const isPastDue = new Date(p.due).getTime() < Date.now()
  const checks = [
    { id: 'registered', label: 'Invoice is on chain', status: 'ok', detail: `Payable ${p.payable_id} is registered on the test registry.`, layer: 'chain' },
    docSha256 === undefined
      ? { id: 'doc', label: 'Document matches the on-chain fingerprint', status: 'not_run', detail: 'No document supplied. This check was not run.', layer: 'app' }
      : docSha256 === p.doc_sha256
        ? { id: 'doc', label: 'Document matches the on-chain fingerprint', status: 'ok', detail: 'The file’s SHA-256 matches the value stored on chain.', layer: 'app' }
        : { id: 'doc', label: 'Document matches the on-chain fingerprint', status: 'fail', detail: 'This file is not the invoice the seller registered. Paying is blocked.', layer: 'app' },
    { id: 'agent', label: 'Seller’s agent is active', status: 'ok', detail: 'Agent token 01000000… is active and owned by the seller. Checked on the test CIS-8004 instance.', layer: 'chain' },
    { id: 'identity', label: 'Seller identity', status: 'info', detail: 'Not verified. No company (LEI) or identity proof is attached to this seller.', layer: 'app' },
    { id: 'payee', label: 'Payee comes from the chain', status: 'info', detail: `${p.payee.slice(0, 8)}…${p.payee.slice(-6)}. The payee is read from the chain, not from the invoice text.`, layer: 'chain' },
    { id: 'amount', label: 'Amount and currency', status: 'info', detail: p.amount_display + (p.asset === 'eudemo' ? ' (testnet demo token)' : ' (testnet)'), layer: 'chain' },
    isPastDue
      ? { id: 'due', label: 'Due date', status: 'fail', detail: 'Past due. The chain refuses payment after the due date.', layer: 'chain' }
      : { id: 'due', label: 'Due date', status: 'ok', detail: `Due ${p.due.slice(0, 10)}, ${p.due.slice(11, 16)} UTC.`, layer: 'chain' },
    p.status.kind === 'paid'
      ? { id: 'status', label: 'Status', status: 'fail', detail: 'Already paid. The chain refuses a second payment.', layer: 'chain' }
      : p.status.kind === 'reserved'
        ? { id: 'status', label: 'Status', status: 'fail', detail: `Reserved for another payment until ${p.status.expires.slice(11, 16)} UTC.`, layer: 'chain' }
        : { id: 'status', label: 'Status', status: 'ok', detail: 'Unpaid. Can be paid once.', layer: 'chain' },
    { id: 'balance', label: 'Registry balance', status: 'ok', detail: 'The registry holds no CCD. Contract keeps no balance between transactions.', layer: 'chain' },
  ]
  const failing = checks.find((c) => c.status === 'fail')
  const verdict = p.status.kind === 'paid' ? 'paid' : failing ? 'blocked' : 'ready'
  return {
    payable_id: p.payable_id,
    mode: 'before_pay',
    verdict,
    passed: checks.filter((c) => c.status === 'ok').length,
    total: 9,
    blocked_reason: failing ? failing.detail : null,
    checks,
    checked_at: new Date().toISOString(),
    read_ms: 2140,
  }
}

function checksAfter(p) {
  if (p.status.kind !== 'paid') {
    return {
      payable_id: p.payable_id, mode: 'after_pay', verdict: 'blocked', passed: 0, total: p.asset === 'ccd' ? 10 : 12,
      blocked_reason: 'Not paid yet.',
      checks: [], checked_at: new Date().toISOString(), read_ms: 100,
    }
  }
  const base = [
    { id: 'registered', label: 'Invoice is on chain', status: 'ok', detail: `Payable ${p.payable_id} is registered on the test registry.`, layer: 'chain' },
    { id: 'doc', label: 'Document matches the on-chain fingerprint', status: 'ok', detail: 'The file’s SHA-256 matches the value stored on chain.', layer: 'app' },
    { id: 'agent', label: 'Seller’s agent is active', status: 'ok', detail: 'Agent token 01000000… is active and owned by the seller.', layer: 'chain' },
    { id: 'registry_zero', label: 'Registry balance is zero', status: 'ok', detail: 'The registry holds no CCD after the payment.', layer: 'chain' },
    { id: 'status', label: 'Status is Paid', status: 'ok', detail: 'The payable is Paid on chain.', layer: 'chain' },
    { id: 'tx_finalized', label: 'Payment transaction finalized', status: 'ok', detail: 'The payment transaction is finalized on chain.', layer: 'chain' },
  ]
  const extra =
    p.asset === 'ccd'
      ? [
          { id: 'invoked_pay_ccd', label: 'pay_ccd was invoked', status: 'ok', detail: 'The transaction invoked pay_ccd on the registry.', layer: 'chain' },
          { id: 'sender_is_payer', label: 'Sender is the payer', status: 'ok', detail: 'The transaction sender is the demo payer account.', layer: 'chain' },
          { id: 'single_transfer_to_payee', label: 'Single transfer to the payee', status: 'ok', detail: 'Exactly one transfer, to the payee on chain.', layer: 'chain' },
          { id: 'no_other_transfer', label: 'No other transfer', status: 'ok', detail: 'No other transfer left the contract in this transaction.', layer: 'chain' },
        ]
      : [
          { id: 'one_token_transfer', label: 'Exactly one token transfer', status: 'ok', detail: 'Exactly one EUDemo transfer in the payment transaction.', layer: 'chain' },
          { id: 'token_eudemo', label: 'Token is EUDemo', status: 'ok', detail: 'The transferred token is EUDemo.', layer: 'chain' },
          { id: 'from_payer', label: 'Transfer is from the payer', status: 'ok', detail: 'The transfer sender is the payer on chain.', layer: 'chain' },
          { id: 'to_payee', label: 'Transfer is to the payee', status: 'ok', detail: 'The transfer recipient is the payee on chain.', layer: 'chain' },
          { id: 'amount', label: 'Amount matches the invoice', status: 'ok', detail: `The transferred amount is ${p.amount_display}.`, layer: 'chain' },
          { id: 'memo', label: 'Memo names the invoice', status: 'ok', detail: `The transfer memo is payable:${p.payable_id}.`, layer: 'chain' },
        ]
  const checks = [...base, ...extra]
  return {
    payable_id: p.payable_id, mode: 'after_pay', verdict: 'paid', passed: checks.length, total: checks.length,
    blocked_reason: null, checks, checked_at: new Date().toISOString(), read_ms: 5000,
  }
}

function receipt(p) {
  if (p.status.kind !== 'paid') return null
  const txs =
    p.asset === 'ccd'
      ? [{ label: 'Payment (pay_ccd)', tx_hash: p.status.payment_tx, explorer_url: EXPLORER_TX + p.status.payment_tx }]
      : [
          { label: 'Reserve', tx_hash: 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1', explorer_url: EXPLORER_TX + 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1' },
          { label: 'Transfer (co-signed)', tx_hash: p.status.payment_tx, explorer_url: EXPLORER_TX + p.status.payment_tx },
          { label: 'Confirm', tx_hash: '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde', explorer_url: EXPLORER_TX + '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde' },
        ]
  const v = checksAfter(p)
  return {
    payable_id: p.payable_id,
    amount_display: p.amount_display,
    payee: p.payee,
    payer_label: 'Demo payer account (lab)',
    txs,
    verifier: { passed: v.passed, total: v.total, checked_at: '2026-11-24T10:42:07Z' },
    payment_tx_source: p.status.payment_tx_source,
  }
}

// Recorded runs (P3 §9/§16.12/§17) — real steps, real hashes, labelled.
const RECORDED = {
  1: {
    payable_id: 1, date: '2026-11-24',
    steps: [
      { step: 'check_status', detail: 'Unpaid. Can be paid once.', layer: 'chain' },
      { step: 'check_agent', detail: 'Agent token active and owned by the seller.', layer: 'chain' },
      { step: 'submit', detail: 'pay_ccd submitted.', txHash: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6', layer: 'chain' },
      { step: 'wait_finality', detail: 'Finalized.', layer: 'chain' },
      { step: 'read_back', detail: 'Status is Paid. Payee received 0.5 CCD.', layer: 'chain' },
      { step: 'verify', detail: '10 of 10 checks passed.', layer: 'chain' },
    ],
  },
  2: {
    payable_id: 2, date: '2026-11-24',
    steps: [
      { step: 'check_wallet', detail: 'Agent wallet holds enough EUDemo.', layer: 'chain' },
      { step: 'reserve', detail: 'Reserved for this payment.', txHash: 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1', layer: 'chain' },
      { step: 'co_sign_decide', detail: 'Co-signer approved: exact amount, stored payee, memo payable:2.', layer: 'co_signer' },
      { step: 'submit_transfer', detail: 'Co-signed transfer submitted.', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', layer: 'chain' },
      { step: 'wait_finality', detail: 'Finalized.', layer: 'chain' },
      { step: 'confirm', detail: 'Payment confirmed against payable 2.', txHash: '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde', layer: 'chain' },
      { step: 'verify', detail: '12 of 12 checks passed.', layer: 'chain' },
    ],
  },
}

const ATTACKS = {
  pay_twice: {
    kind: 'pay_twice', payable_id: 1, layer: 'chain', live: false, tx_sent: true, outcome: 'refused',
    reject: { code: -5, name: 'WrongStatus', plain: 'This invoice is already paid, so the chain refused a second payment. Nothing moved.' },
    fee_testnet_ccd: '4.928645',
    tx_hash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
    explorer_url: EXPLORER_TX + 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
    recorded_example: { date: '2026-11-24' },
    plain: 'The chain refused a second payment. Nothing moved. A fee was charged.',
  },
  wrong_amount: {
    kind: 'wrong_amount', payable_id: 1, layer: 'chain', live: false, tx_sent: true, outcome: 'refused',
    reject: { code: -6, name: 'WrongAmount', plain: 'The amount does not match the invoice. The chain refused it. Nothing was moved.' },
    fee_testnet_ccd: '4.928645',
    tx_hash: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c',
    explorer_url: EXPLORER_TX + '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c',
    recorded_example: { date: '2026-11-24' },
    plain: 'The chain refused the amount. Nothing moved.',
  },
  unlisted_seller: {
    kind: 'unlisted_seller', payable_id: 1, layer: 'app', live: true, tx_sent: false, outcome: 'refused',
    reject: null, fee_testnet_ccd: null, tx_hash: null, explorer_url: null,
    recorded_example: null,
    plain: 'This app: this seller is not on your vendor list. Nothing was sent to the chain. The co-signer dry run for the same invoice: approve (the vendor check is not enforced by the co-signer yet).',
  },
}

function err(res, status, code, layer, message, extra = {}) {
  const body = { error: { code, layer, message, retryable: false, reject: null, fee_testnet_ccd: null, tx_hash: null, explorer_url: null, ...extra } }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const json = (s) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)) }
    try {
      if (path === '/api/config') return json(CONFIG)
      if (path === '/api/health') return json(HEALTH)
      if (path === '/api/stats') return json(stats())
      if (path === '/api/invoices') {
        return json({ items: PAYABLES.map((p) => ({ payable_id: p.payable_id, asset: p.asset, amount_display: p.amount_display, due: p.due, status: p.status.kind, label: 'Lab invoice (testnet, not real)' })) })
      }
      const mPayable = path.match(/^\/api\/payables\/(\d+)$/)
      if (mPayable && req.method === 'GET') {
        const p = PAYABLES.find((x) => x.payable_id === Number(mPayable[1]))
        if (!p) return err(res, 404, 'not_found', 'server', 'No payable with this number is on the test registry.')
        return json(payableView(p))
      }
      const mDoc = path.match(/^\/api\/payables\/(\d+)\/document$/)
      if (mDoc && req.method === 'GET') {
        const p = PAYABLES.find((x) => x.payable_id === Number(mDoc[1]))
        if (!p) return err(res, 404, 'not_found', 'server', 'No payable with this number is on the test registry.')
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        return res.end(p.document)
      }
      const mVerify = path.match(/^\/api\/payables\/(\d+)\/verify$/)
      if (mVerify && req.method === 'POST') {
        const p = PAYABLES.find((x) => x.payable_id === Number(mVerify[1]))
        if (!p) return err(res, 404, 'not_found', 'server', 'No payable with this number is on the test registry.')
        const parsed = JSON.parse(body || '{}')
        return json(parsed.mode === 'after_pay' ? checksAfter(p) : checksBefore(p, parsed.doc_sha256))
      }
      const mReceipt = path.match(/^\/api\/(?:receipts\/(\d+)|payables\/(\d+)\/receipt)$/)
      if (mReceipt && req.method === 'GET') {
        const id = Number(mReceipt[1] ?? mReceipt[2])
        const p = PAYABLES.find((x) => x.payable_id === id)
        if (!p || p.status.kind !== 'paid') return err(res, 404, 'not_found', 'server', 'No receipt for this payable yet.')
        return json(receipt(p))
      }
      const mRecorded = path.match(/^\/api\/recorded\/(\d+)$/)
      if (mRecorded && req.method === 'GET') {
        const run = RECORDED[Number(mRecorded[1])]
        if (!run) return err(res, 404, 'not_found', 'server', 'No recorded run for this payable.')
        return json(run)
      }
      const mAttack = path.match(/^\/api\/attacks\/(pay_twice|wrong_amount|unlisted_seller)$/)
      if (mAttack && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}')
        const a = { ...ATTACKS[mAttack[1]], payable_id: parsed.payable_id ?? 1 }
        return json(a)
      }
      if (path === '/api/cosigner/dry-run' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}')
        const p = PAYABLES.find((x) => x.payable_id === parsed.payable_id)
        if (!p) return err(res, 404, 'not_found', 'server', 'No payable with this number is on the test registry.')
        if (parsed.to !== p.payee) {
          return json({ decision: 'refuse', reason: `recipient ${parsed.to} is not the stored payee ${p.payee}`, plain: 'The transfer would go to an account other than the payee on chain.', tx_sent: false })
        }
        if (parsed.amount !== p.amount) {
          return json({ decision: 'refuse', reason: `amount ${parsed.amount} is not the stored amount ${p.amount}`, plain: 'The transfer amount does not match the invoice.', tx_sent: false })
        }
        if (parsed.memo !== `payable:${p.payable_id}`) {
          return json({ decision: 'refuse', reason: 'memo must be exactly payable:<id>', plain: 'The transfer memo does not name this invoice.', tx_sent: false })
        }
        return json({ decision: 'approve', reason: 'exact amount, stored payee, memo payable:<id>', plain: 'Approved.', tx_sent: false })
      }
      if (path === '/api/judges/files' && req.method === 'GET') {
        return json({ files: [
          { name: 'verify-payable.mjs', url: '/api/judges/files/verify-payable.mjs', sha256: 'not-published-in-stub' },
          { name: 'PAYABLE_LOG.md', url: '/api/judges/files/PAYABLE_LOG.md', sha256: 'not-published-in-stub' },
        ] })
      }
      const mTx = path.match(/^\/api\/tx\/([0-9a-f]{64})\/status$/)
      if (mTx && req.method === 'GET') {
        const known = Object.values(ATTACKS).find((a) => a.tx_hash === mTx[1])
        if (known) return json({ tx_hash: mTx[1], status: 'rejected', reject: known.reject, fee_testnet_ccd: known.fee_testnet_ccd, explorer_url: known.explorer_url })
        return json({ tx_hash: mTx[1], status: 'finalized', reject: null, fee_testnet_ccd: '7.073229', explorer_url: EXPLORER_TX + mTx[1] })
      }
      // POST /pay and POST /payables return an honest 503: the stub never
      // sends a transaction. (mPayable above only matches /payables/<id>,
      // so the /pay suffix needs its own match — a bare endsWith('/pay')
      // check against mPayable never fires.)
      const mPay = path.match(/^\/api\/payables\/(\d+)\/pay$/)
      if ((path === '/api/payables' && req.method === 'POST') || (mPay && req.method === 'POST')) {
        return err(res, 503, 'internal', 'server', 'Not available in the dev stub. The stub never sends a transaction. Use the real backend, or watch the recorded run.')
      }
      return err(res, 404, 'not_found', 'server', 'Unknown route in the dev stub.')
    } catch (e) {
      return err(res, 500, 'internal', 'server', 'Stub error: ' + (e instanceof Error ? e.message : String(e)))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PayOnce dev API stub on http://127.0.0.1:${PORT} (dev only — never sends a transaction)`)
  console.log(`Snapshot: contract <13149,0> read live via gRPC ${SNAPSHOT_AT}; registry balance 0 microCCD`)
  for (const p of PAYABLES) console.log(`  payable ${p.payable_id}: ${p.asset} ${p.amount_display} ${p.status.kind} doc_sha256=${p.doc_sha256.slice(0, 12)}…`)
})
