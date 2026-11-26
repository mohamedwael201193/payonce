// Captures public/landing/snapshot.json from the live testnet API.
// Run: node src/landing/capture-snapshot.mjs   (from frontend/)
// Everything in the file is copied from API responses or counted from the
// repo's own test files. Nothing is typed by hand.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const API = process.env.API_BASE || 'https://payonce-api-n98a.onrender.com'
const here = resolve(import.meta.dirname, '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(path, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API + path, { signal: AbortSignal.timeout(45000) })
      if (res.ok) return await res.json()
    } catch { /* retry */ }
    await sleep(2500)
  }
  return null
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.test\.(ts|tsx|mjs|js)$/.test(n)) out.push(p)
  }
  return out
}
function countTests(roots) {
  let files = 0
  let cases = 0
  for (const r of roots) {
    let list = []
    try { list = walk(r) } catch { continue }
    for (const f of list) {
      files += 1
      const src = readFileSync(f, 'utf8')
      cases += (src.match(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(/gm) || []).length
    }
  }
  return { files, cases }
}

const stats = await get('/api/stats')
const inv = await get('/api/invoices')
const items = inv?.items ?? []
const paid = items.filter((i) => i.status === 'Paid')
const unpaid = items.filter((i) => i.status === 'Unpaid')

const receipts = []
for (const p of paid.slice(-14).reverse()) {
  const r = await get(`/api/receipts/${p.payable_id}?seller=${encodeURIComponent(p.seller)}`, 3)
  if (r && r.txs?.length) {
    receipts.push({
      payable_id: r.payable_id,
      seller: r.seller ?? p.seller,
      amount_display: r.amount_display,
      payee: r.payee,
      txs: r.txs.map((t) => ({ label: t.label, tx_hash: t.tx_hash })),
      verifier: r.verifier,
    })
  }
}

// One payable's facts for the tamper test: payee and doc_sha256 from the API.
let facts = null
for (const p of [...paid.filter((x) => x.payable_id === 10), ...[...paid].reverse()]) {
  const f = await get(`/api/payables/${p.payable_id}?seller=${encodeURIComponent(p.seller)}`, 3)
  if (f && f.doc_sha256 && f.payee) {
    facts = { payable_id: f.payable_id, seller: f.seller, payee: f.payee, amount_display: f.amount_display, asset: f.asset?.kind, due: f.due, doc_sha256: f.doc_sha256, label: f.label, status: f.status?.kind }
    // The invoice document itself, so the page can re-hash an edited copy.
    try {
      const d = await fetch(`${API}/api/payables/${f.payable_id}/document?seller=${encodeURIComponent(f.seller)}`, { signal: AbortSignal.timeout(45000) })
      const text = await d.text()
      const sha = createHash('sha256').update(text).digest('hex')
      facts.document = text
      facts.document_matches_chain = sha === f.doc_sha256
    } catch { /* leave undocumented */ }
    break
  }
}

const recSeller = facts?.seller ?? paid[0]?.seller ?? ''
const recId = facts?.payable_id ?? 10
const recorded = await get(`/api/recorded/${recId}?seller=${encodeURIComponent(recSeller)}`, 3)

// The verifier's own check list for that payable (read-only POST).
let verify = null
if (facts) {
  try {
    const v = await fetch(`${API}/api/payables/${facts.payable_id}/verify?seller=${encodeURIComponent(facts.seller)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'after_pay' }), signal: AbortSignal.timeout(45000),
    })
    if (v.ok) {
      const j = await v.json()
      verify = { payable_id: j.payable_id, verdict: j.verdict, passed: j.passed, total: j.total, checked_at: j.checked_at, checks: j.checks.map((c) => ({ id: c.id, label: c.label, status: c.status })) }
    }
  } catch { /* none */ }
}
const config = await get('/api/config', 3)

const repoRoot = resolve(here, '..')
const tests = {
  frontend: countTests([join(here, 'src')]),
  api: countTests([join(repoRoot, 'api'), join(repoRoot, 'backend')]),
}

const snapshot = {
  captured_at: new Date().toISOString(),
  api_base: API,
  stats,
  invoices: items.map((i) => ({ payable_id: i.payable_id, seller: i.seller, asset: i.asset, amount_display: i.amount_display, due: i.due, status: i.status, label: i.label })),
  facts,
  receipts,
  recorded_run_date: recorded?.date ?? null,
  recorded_steps: recorded ? { payable_id: recorded.payable_id, steps: recorded.steps.map((x) => ({ step: x.step, detail: x.detail, txHash: x.txHash ?? null })) } : null,
  verify,
  config: config ? { network: config.network, registry: config.registry, explorer: config.explorer, reservation_secs: config.reservation_secs, verifier: config.verifier } : null,
  tests,
  counts: { listed: items.length, paid: paid.length, unpaid: unpaid.length },
}
if (!stats || !items.length) { console.error('API did not answer; snapshot not written'); process.exit(1) }
writeFileSync(join(here, 'public', 'landing', 'snapshot.json'), JSON.stringify(snapshot, null, 1))
console.log('snapshot written', snapshot.counts, tests, 'receipts', receipts.length, 'facts', !!facts)
