// PayOnce click-test — the user order (2026-11-24 09:31): judge by USING it.
// Drives the real app in headless Chromium (stock Playwright build, cached
// at ~/.cache/ms-playwright/chromium-1255) against the dev stub (real
// recorded testnet snapshot). Every section clicks the real UI and asserts
// the real result; a failed section is recorded and the run continues, so
// one failure cannot hide the rest. Exit 1 on any failure.
// Evidence: ./evidence/ (screenshots + CLICKTEST_LOG.md). The stub never
// sends a transaction, so the Pay step is expected to show the honest 503 —
// the real-backend pay path is verified when the backend lands.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const FRONTEND = '/home/hatch/workspace/payonce-build/frontend'
const EVIDENCE = '/home/hatch/workspace/payonce-build/clicktest/evidence'
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'
const BASE = 'http://localhost:5173'

mkdirSync(EVIDENCE, { recursive: true })

const log = []
const errors = []
function step(name, ok, detail = '') {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) errors.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
async function section(name, fn) {
  try {
    await fn()
  } catch (e) {
    step(name, false, String(e.message).split('\n')[0])
  }
}

async function waitPort(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const stub = spawn('node', ['scripts/dev-api-stub.mjs'], { cwd: FRONTEND, stdio: 'ignore' })
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: FRONTEND, stdio: 'ignore' })

let browser
try {
  if (!(await waitPort('http://127.0.0.1:7401/api/stats'))) throw new Error('stub did not start')
  if (!(await waitPort(`${BASE}/`))) throw new Error('vite did not start')

  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  const pageErrors = []
  const badResponses = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`)
  })
  const consoleSection = page.locator('section[aria-labelledby="console-title"]')

  await section('home loads', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Every invoice paid once. Every payment provable.' }).waitFor()
    const statsText = await page.getByLabel('Live registry stats').innerText()
    step('hero loads with live stats', /5/.test(statsText) && /3/.test(statsText) && /7/.test(statsText), statsText.replace(/\n/g, ' | '))
    const heroH = await page.evaluate(() => document.querySelector('section[aria-labelledby="hero-title"]').getBoundingClientRect().height)
    step('compact hero ≤ 220px tall (F10f)', heroH <= 220, `${Math.round(heroH)}px`)
    await page.screenshot({ path: `${EVIDENCE}/d-home-top-1440.png` })
  })

  // Fix-back-12: the flow moved to /dashboard manual tabs — the P3 §1
  // "steps 1–3 fit" home check is gone with it. The tabs show one step at
  // a time; this section checks the pay-tabs section lands on screen and
  // the dashboard has no horizontal overflow at 1440.
  await section('pay tabs fit (fix-back-12)', async () => {
    await page.goto(`${BASE}/dashboard?tab=pick#pay`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Pick an invoice/ }).waitFor()
    const fit = await page.evaluate(() => {
      const pay = document.getElementById('pay')
      return { payTop: pay ? Math.round(pay.getBoundingClientRect().top) : null }
    })
    step('pay-tabs section is on screen after nav', fit.payTop !== null && fit.payTop >= 0, `pay top ${fit.payTop}px`)
    const overflowD = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
    step('no horizontal overflow at 1440', overflowD.sw === overflowD.iw, `scrollWidth ${overflowD.sw} vs innerWidth ${overflowD.iw}`)
  })

  await section('skip link (F4)', async () => {
    // Fix-back-12: the skip link now reads "Skip to main content" and
    // jumps to #main — the old #invoice target is gone with the landing flow.
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.keyboard.press('Tab')
    const skipFocused = await page.evaluate(() => document.activeElement?.textContent?.includes('Skip to main content'))
    step('skip link is first Tab stop', skipFocused === true)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    const skipTarget = await page.evaluate(() => {
      const el = document.getElementById('main')
      return el ? Math.round(el.getBoundingClientRect().top) : null
    })
    step('skip link jumps to #main', skipTarget !== null && Math.abs(skipTarget) < 120, `main top after jump: ${skipTarget}px`)
  })

  await section('dashboard console tabs', async () => {
    await page.locator('#console-title').scrollIntoViewIfNeeded()
    await page.getByRole('tab', { name: /Unpaid/ }).click()
    await page.waitForTimeout(300)
    // Scope to the invoice list rows: the console section also shows the
    // verifier line, which names payable 1 even on the Unpaid tab.
    const rowTexts = await consoleSection.locator('li:has-text("Payable")').allInnerTexts()
    const rows = rowTexts.join(' | ')
    step('Unpaid tab shows 3 and 5, hides paid 1', rows.includes('Payable 3') && rows.includes('Payable 5') && !rows.includes('Payable 1'), rows)
    await page.getByRole('tab', { name: /Refused/ }).click()
    await page.getByText(/-5 · WrongStatus/).waitFor()
    step('Refused tab lists 7 recorded refusals', (await consoleSection.getByText(/· WrongStatus|· WrongAmount|· NotFound|· AlreadyReservedOrPaid|· TxReused|· NotPayerOrSeller|· NotExpired/).count()) >= 7)
    await page.getByRole('tab', { name: /^All$/ }).click()
    step('gauge shows 60% (3 of 5 paid once)', (await page.getByText('60%').count()) >= 1)
    step('fees chart shows recorded run + not measured', (await page.getByText('16.205').count()) >= 1 && (await page.getByText(/not measured — no bar/).count()) >= 1)
    await page.screenshot({ path: `${EVIDENCE}/d-console-1440.png` })
  })

  await section('invoice 3 + 9 checks + honest pay 503', async () => {
    // Fix-back-12: the flow lives in the dashboard tabs now.
    await page.goto(`${BASE}/dashboard?tab=pick#pay`, { waitUntil: 'networkidle' })
    await page.locator('#pay').scrollIntoViewIfNeeded()
    await page.locator('#lab-invoice').selectOption({ value: '3' })
    await page.getByText('Payable 3 — 0.01 EUDemo').waitFor({ timeout: 10000 })
    step('lab invoice 3 loads with chain facts', true, 'Payable 3 — 0.01 EUDemo')
    await page.getByText(/Fingerprint [0-9a-f]{8}…[0-9a-f]{6}/).waitFor()
    step('fingerprint shown first-8 + last-6', true)
    await page.getByRole('button', { name: /Continue to Check/ }).click()
    await page.locator('#panel-check').getByRole('button', { name: 'Check invoice', exact: true }).click()
    await page.getByText(/All checks passed/).waitFor({ timeout: 15000 })
    step('9 checks run, verdict ready', (await page.locator('text=Document matches the on-chain fingerprint').count()) >= 1, 'verdict: All checks passed')
    await page.getByRole('button', { name: /Continue to Pay/ }).click()
    step('Pay in EUDemo enabled after ready check', await page.locator('#pay-eudemo').isEnabled())
    await page.screenshot({ path: `${EVIDENCE}/d-flow-checked-1440.png` })
    await page.locator('#pay-eudemo').click()
    await page.getByText(/Not available in the dev stub/).waitFor({ timeout: 10000 })
    step('pay shows honest stub 503, no crash', true, 'The stub never sends a transaction')
  })

  await section('try to break it', async () => {
    // Payable 3 has no recorded run: the honest answer is "no run", not steps.
    await page.getByRole('button', { name: 'Watch the recorded run' }).click()
    await page.getByText(/No recorded run for this payable/).waitFor({ timeout: 10000 })
    step('payable 3: honest "no recorded run" (not a fake run)', true)
    // Payable 2 is paid: its recorded run exists, and "Pay it twice" is live.
    await page.locator('#lab-invoice').selectOption({ value: '2' })
    await page.getByText('Payable 2 — 0.01 EUDemo').waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: 'Watch the recorded run' }).click()
    await page.getByText('check_wallet').waitFor({ timeout: 10000 })
    step('payable 2: recorded run shows real steps (check_wallet…verify)', true)
    await page.getByRole('button', { name: 'Pay it twice' }).click()
    await page.getByText(/WrongStatus/).waitFor({ timeout: 10000 })
    step('pay twice refused by chain (-5) with fee', (await page.getByText('4.928645').count()) >= 1)
    // Back to unpaid payable 3 for the amount / seller / tamper / injection attacks.
    await page.locator('#lab-invoice').selectOption({ value: '3' })
    await page.getByText('Payable 3 — 0.01 EUDemo').waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: 'Wrong amount' }).click()
    await page.getByText(/WrongAmount/).waitFor({ timeout: 10000 })
    step('wrong amount refused by chain (-6) with fee', (await page.getByText('4.928645').count()) >= 1)
    await page.getByRole('button', { name: 'Pay a fraudster’s invoice' }).click()
    await page.getByText(/This app: this seller is not on your vendor list/).waitFor({ timeout: 10000 })
    step('unlisted seller refused by this app (no tx)', true)
    await page.getByRole('button', { name: 'Tamper with the invoice' }).click()
    await page.getByText(/does not match the chain fingerprint/).waitFor({ timeout: 10000 })
    step('tamper detected (hash mismatch, pay blocked)', true)
    await page.getByRole('button', { name: 'Injection: tell the agent to pay another account' }).click()
    await page.getByText(/Ignored\. The invoice text is evidence only/).waitFor({ timeout: 10000 })
    step('injection ignored (payee is the account on chain)', true)
    await page.screenshot({ path: `${EVIDENCE}/d-try-1440.png` })
  })

  await section('receipt page', async () => {
    await page.goto(`${BASE}/receipt/2`, { waitUntil: 'networkidle' })
    await page.getByText('Paid once.').waitFor({ timeout: 10000 })
    await page.getByText(/12 of 12 checks passed/).waitFor({ timeout: 10000 })
    step('receipt 2: paid once, verifier 12/12', true)
    await page.getByRole('button', { name: 'Check again on chain' }).click()
    await page.getByText(/12 of 12 checks passed/).waitFor({ timeout: 10000 })
    step('receipt re-verify works (Check again on chain)', true)
    await page.screenshot({ path: `${EVIDENCE}/d-receipt-1440.png` })
  })

  await section('judges page', async () => {
    await page.goto(`${BASE}/judges`, { waitUntil: 'networkidle' })
    await page.getByText('Glossary').waitFor()
    const glossaryText = await page.locator('section[aria-labelledby="glossary"]').innerText()
    step('glossary uses "reserved", never "held"', glossaryText.includes('reserved for one payer') && !glossaryText.includes('held'))
    step('judges page renders (verifier, limits, build status)', (await page.getByText('Known limits').count()) >= 1)
    await page.screenshot({ path: `${EVIDENCE}/d-judges-1440.png` })
  })

  await section('receipt checker', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    // The checker runs when it scrolls into view (inView, once). Scroll to
    // the bottom of the page so it is fully visible, then wait for the stages.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.getByText('Paid once: yes').waitFor({ timeout: 20000 })
    step('receipt checker reaches stage 4 (Paid once: yes)', true)
    await page.getByRole('button', { name: /Replay/ }).click()
    await page.getByText('Fetch payable').waitFor({ timeout: 10000 })
    step('receipt checker replay restarts stages', true)
  })

  await section('error hygiene', async () => {
    step('zero page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none')
    // Chrome logs a failed fetch as "Failed to load resource: … status of
    // NNN" WITHOUT the URL, so a console entry cannot be matched to its
    // request by text. Instead, consume allowances from the expected failed
    // responses (the honest 503 when paying against the stub, and the honest
    // 404 for a recorded run that does not exist for payable 3): one console
    // entry per expected response, in the same status. Anything left over
    // is a real unexpected error.
    const expected503 = badResponses.filter((r) => r.startsWith('503 ')).length
    const expected404 = badResponses.filter((r) => r.startsWith('404 ') && r.includes('/api/recorded/3')).length
    let allow503 = expected503
    let allow404 = expected404
    const realConsoleErrors = consoleErrors.filter((t) => {
      if (t.includes('503 (Service Unavailable)') && allow503 > 0) {
        allow503--
        return false
      }
      if (t.includes('404 (Not Found)') && allow404 > 0) {
        allow404--
        return false
      }
      return true
    })
    step('zero unexpected console errors', realConsoleErrors.length === 0, realConsoleErrors.join(' | ') || 'none')
    const unexpectedBad = badResponses.filter((r) => !r.includes('/api/payables/3/pay') && !r.includes('/api/recorded/3'))
    step('no unexpected failed responses (pay 503 + recorded/3 404 are expected)', unexpectedBad.length === 0, unexpectedBad.join(' | ') || 'only the expected ones')
  })

  await section('mobile 390', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(BASE, { waitUntil: 'networkidle' })
    const overflowM = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
    step('no horizontal overflow at 390', overflowM.sw === overflowM.iw, `scrollWidth ${overflowM.sw} vs innerWidth ${overflowM.iw}`)
    // Fix-back-12: the sticky bottom pay bar is deleted with the landing
    // flow — no fixed pay bar may exist on the landing at 390.
    step('no sticky pay bar on the landing at 390', (await page.locator('div.fixed.inset-x-0.bottom-0').count()) === 0)
    await page.screenshot({ path: `${EVIDENCE}/m-home-390.png` })
    // The flow is driven in the dashboard tabs at 390.
    await page.goto(`${BASE}/dashboard?tab=pick#pay`, { waitUntil: 'networkidle' })
    await page.locator('#pay').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${EVIDENCE}/m-flow-390.png` })
    await page.locator('#lab-invoice').selectOption({ value: '3' })
    await page.getByText('Payable 3 — 0.01 EUDemo').waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: /Continue to Check/ }).click()
    await page.locator('#panel-check').getByRole('button', { name: 'Check invoice', exact: true }).click()
    await page.getByText(/All checks passed/).waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: /Continue to Pay/ }).click()
    step('pay tab shows Pay 0.01 EUDemo (3 steps) after check', (await page.getByText('Pay 0.01 EUDemo (3 steps)').count()) >= 1)
    await page.screenshot({ path: `${EVIDENCE}/m-flow-pay-390.png` })
  })

  writeFileSync(`${EVIDENCE}/CLICKTEST_LOG.md`, `# PayOnce click-test log\n\n${log.join('\n')}\n\nConsole errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}\nPage errors: ${pageErrors.length ? pageErrors.join(' | ') : 'none'}\nFailed responses: ${badResponses.length ? badResponses.join(' | ') : 'none'}\n\nResult: ${errors.length === 0 ? 'ALL PASS' : `${errors.length} FAILURES: ${errors.join(', ')}`}\n`)
} catch (e) {
  step(`click-test crashed: ${e.message}`, false)
  writeFileSync(`${EVIDENCE}/CLICKTEST_LOG.md`, `# PayOnce click-test log\n\n${log.join('\n')}\n\nCRASH: ${e.stack}\n`)
} finally {
  if (browser) await browser.close()
  stub.kill()
  vite.kill()
  process.exit(errors.length === 0 ? 0 : 1)
}
