// Playwright "Concordium Browser Wallet" stand-in for end-to-end runs of /app/wallet and /app/sell on live testnet.
// window.concordium is a shim whose sendTransaction / signMessage call back into this Node process, which signs with a
// testnet key derived in-process from a seed file (never printed, never written) and submits through Concordium's
// public wallet-proxy. The real extension does the same three things: build, sign, submit.
//
//   node qa/e2e/wallet-shim.mjs <flow: pay|sell> <base url>   (env: SHIM_SEED_FILE, SHIM_IDENTITY, SHIM_CREDENTIAL, SHIM_INVOICE, PLAYWRIGHT_DIR)
// The account must be single-key (threshold 1). QA account: identity 1, credential 6 (3okVZT…), deployed for this test.
// Honest limit: the account is derived from PayOnce's own test seed, so it is a stand-in, not an outside party.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const sdk = require('@concordium/web-sdk');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_DIR ?? process.cwd(), new URL('../../frontend', import.meta.url).pathname] }));

const WP = 'https://wallet-proxy.testnet.concordium.com';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const [flow = 'pay', base = 'http://localhost:4173'] = process.argv.slice(2);

function loadSigner() {
  const txt = readFileSync(process.env.SHIM_SEED_FILE ?? '/workspace/concordium/.secrets/env.latest.txt', 'utf8');
  const seed = (/^seed_phares\s*=\s*(.+)$/m.exec(txt)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  if (!seed) throw new Error('no seed in SHIM_SEED_FILE');
  return seed;
}
const seed = loadSigner();
const g = await (await fetch(`${WP}/v0/global`)).json();
const w = sdk.ConcordiumHdWallet.fromSeedPhrase(seed, 'Testnet');
const ID = Number(process.env.SHIM_IDENTITY ?? 1); const CRED = Number(process.env.SHIM_CREDENTIAL ?? 6);
const address = sdk.getAccountAddress(w.getCredentialId(0, ID, CRED, g.value)).address;
const signer = sdk.buildBasicAccountSigner(w.getAccountSigningKey(0, ID, CRED).toString('hex'));
console.log(JSON.stringify({ shim_account: address }));

const log = [];
async function submitUpdate(p) {
  const nonce = (await (await fetch(`${WP}/v0/accNonce/${address}`)).json()).nonce;
  const payload = sdk.Payload.updateContract({
    amount: sdk.CcdAmount.fromMicroCcd(BigInt(p.amount)),
    address: sdk.ContractAddress.create(BigInt(p.index), BigInt(p.subindex)),
    receiveName: sdk.ReceiveName.fromString(p.receiveName),
    message: p.paramHex != null ? sdk.Parameter.fromHexString(p.paramHex) : sdk.Parameter.fromBuffer(sdk.serializeTypeValue(p.params, Buffer.from(p.schema, 'base64')).buffer),
  });
  const tx = sdk.Transaction.updateContract(payload, sdk.Energy.create(BigInt(p.energy))).addMetadata({
    sender: sdk.AccountAddress.fromBase58(address), nonce: sdk.SequenceNumber.create(BigInt(nonce)), expiry: sdk.TransactionExpiry.futureMinutes(5),
  });
  const fin = await sdk.Transaction.signAndFinalize(tx.build(), signer);
  const bytes = sdk.Transaction.serializeBlockItem(fin);
  const r = await fetch(`${WP}/v0/submitRawTransaction`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.submissionId) throw new Error(`wallet-proxy refused the submission (${r.status} ${JSON.stringify(j).slice(0, 160)})`);
  log.push({ receiveName: p.receiveName, amount: p.amount, tx: j.submissionId });
  console.log(JSON.stringify({ submitted: p.receiveName, amount_micro: p.amount, tx: j.submissionId }));
  return j.submissionId;
}
let idObject = null; let ipInfo = null;
async function loadIdentity() {
  if (idObject) return;
  const ips = await (await fetch(`${WP}/v2/ip_info`)).json();
  const ip = ips.find((x) => x.ipInfo.ipIdentity === 0);
  const req = sdk.createIdentityRecoveryRequestWithKeys({ idCredSec: w.getIdCredSec(0, ID).toString('hex'), ipInfo: ip.ipInfo, globalContext: g.value, timestamp: Math.floor(Date.now() / 1000) });
  const r = await fetch(`${ip.metadata.recoveryStart}?state=${encodeURIComponent(JSON.stringify({ idRecoveryRequest: req }))}`);
  const j = await r.json();
  idObject = j.value ?? j; ipInfo = ip;
}
/** What requestVerifiablePresentation (V0, the CryptoX / Web3 ID path) does: ZK-prove the statements for this account's credential. */
async function proveV0(challenge, statements) {
  await loadIdentity();
  const credId = w.getCredentialId(0, ID, CRED, g.value);
  const attrs = idObject.attributeList.chosenAttributes;
  const atomic = statements.flatMap((x) => x.statement);
  const ci = sdk.createAccountCommitmentInputWithHdWallet(atomic, 0, attrs, w, ID, CRED);
  const pres = sdk.getVerifiablePresentation({
    request: { challenge, credentialStatements: [{ type: 'cred', id: `did:ccd:testnet:cred:${credId}`, statement: atomic }] },
    globalContext: g.value, commitmentInputs: [ci],
  });
  return JSON.parse(JSON.stringify(pres));
}
async function sign(msg) {
  const s = await sdk.signMessage(sdk.AccountAddress.fromBase58(address), msg, signer);
  return JSON.parse(JSON.stringify(s));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 200)); });
await page.exposeFunction('__shimSubmit', async (p) => { try { return await submitUpdate(p); } catch (e) { console.log('[shim submit error]', String(e?.message ?? e).slice(0, 300)); throw e; } });
await page.exposeFunction('__shimSign', sign);
await page.exposeFunction('__shimProveV0', async (c, st) => { try { return await proveV0(c, st); } catch (e) { console.log('[shim prove error]', String(e?.message ?? e).slice(0, 300)); throw e; } });
await page.addInitScript(({ address, GENESIS }) => {
  const big = (v) => (typeof v === 'bigint' ? v.toString() : v);
  window.concordium = {
    requestAccounts: async () => [address],
    getMostRecentlySelectedAccount: async () => address,
    getSelectedChain: async () => GENESIS,
    on() {}, removeListener() {}, addListener() {},
    async sendTransaction(acct, type, payload, params, schema) {
      const p = {
        amount: big(payload.amount?.microCcdAmount ?? payload.amount),
        index: big(payload.address?.index), subindex: big(payload.address?.subindex),
        receiveName: payload.receiveName?.value ?? String(payload.receiveName),
        energy: big(payload.maxContractExecutionEnergy?.value ?? payload.maxContractExecutionEnergy),
        params, schema: typeof schema === 'string' ? schema : schema?.value,
      };
      try { return await window.__shimSubmit(JSON.parse(JSON.stringify(p, (k, v) => big(v)))); }
      catch (e) { console.error('[shim] ' + (e?.message ?? e)); throw e; }
    },
    async requestVerifiablePresentation(challenge, statements) {
      const p = await window.__shimProveV0(challenge, JSON.parse(JSON.stringify(statements)));
      Object.defineProperty(p, 'toString', { value: () => JSON.stringify(p), enumerable: false });
      return p;
    },
    async signMessage(acct, msg) { return window.__shimSign(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
  };
}, { address, GENESIS });

const shot = async (name) => page.screenshot({ path: `/tmp/e2e-${flow}-${name}.png`, fullPage: true });
const t0 = Date.now();
try {
  if (flow === 'pay') {
    // /app Run-it flow with "My own wallet" as the payer.
    await page.goto(`${base}/app`);
    await page.getByLabel(/My own wallet/).check();
    await page.locator('#connect-browser').click();
    await page.getByTestId('wallet-connected').waitFor({ timeout: 20_000 });
    await page.getByTestId('test-ccd').waitFor({ timeout: 20_000 });
    await page.getByText(/Balance:|not on testnet/).first().waitFor({ timeout: 30_000 });
    await shot('1-connected');
    const faucet = page.locator('#get-test-ccd');
    if (await faucet.isVisible().catch(() => false)) {
      await faucet.click();
      await page.getByText('Enough for every step.').waitFor({ timeout: 180_000 });
      console.log(JSON.stringify({ faucet: 'ok' }));
    }
    await page.getByRole('button', { name: 'Continue with this account' }).click();
    await page.getByRole('button', { name: 'Get an invoice' }).click();
    await page.getByRole('button', { name: 'Let the agent check it' }).waitFor({ timeout: 120_000 });
    await shot('2-invoice');
    await page.getByRole('button', { name: 'Let the agent check it' }).click();
    await page.getByTestId('run-verdict').waitFor({ timeout: 90_000 });
    await shot('3-verdict');
    await page.getByRole('button', { name: 'Approve and pay' }).click();
    await page.getByRole('button', { name: 'Pay from my wallet' }).click();
    await page.getByText('Paid once', { exact: true }).waitFor({ timeout: 180_000 });
    await shot('4-paid');
    await page.getByRole('button', { name: /Send the same payment again/ }).click();
    await page.getByText(/^Refused\./).waitFor({ timeout: 180_000 });
    await shot('5-refused');
    console.log(JSON.stringify({ ok: true, flow, seconds: Math.round((Date.now() - t0) / 1000), txs: log }));
  }
  if (flow === 'sell') {
    await page.goto(`${base}/app/sell`);
    await page.locator('#connect-browser').click();
    await page.getByTestId('wallet-connected').waitFor({ timeout: 20_000 });
    await page.getByTestId('test-ccd').waitFor({ timeout: 30_000 });
    await shot('1-connected');
    await page.getByText(/Balance:/).waitFor({ timeout: 30_000 });
    const faucet = page.locator('#get-test-ccd');
    if (await faucet.isVisible().catch(() => false)) { await faucet.click(); await page.getByText('Enough for every step').waitFor({ timeout: 180_000 }); }
    // 3. agent
    const reg = page.locator('#register-agent');
    await Promise.race([reg.waitFor({ timeout: 40_000 }), page.getByText(/Verified by Concordium badge valid/).waitFor({ timeout: 40_000 })]).catch(() => {});
    if (await reg.isVisible().catch(() => false)) {
      await page.getByLabel(/Business or agent name/).fill(process.env.SHIM_NAME ?? 'PayOnce QA Studio');
      await page.getByLabel(/What you sell/).fill('QA invoices for the PayOnce wallet end-to-end test.');
      await reg.click();
    }
    await page.getByText(/Verified by Concordium badge valid/).waitFor({ timeout: 300_000 });
    console.log(JSON.stringify({ step: 'agent ok' }));
    await shot('2-agent');
    // 4. payee proof (V0 through the shim)
    const prove = page.locator('#prove-name');
    await Promise.race([prove.waitFor({ timeout: 30_000 }), page.getByTestId('payee-proof-done').waitFor({ timeout: 30_000 })]).catch(() => {});
    if (await prove.isVisible().catch(() => false)) await prove.click();
    await page.getByTestId('payee-proof-done').waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: 'proof ok' }));
    await shot('3-proof');
    // 5. list
    await Promise.race([page.locator('#list-seller').waitFor({ timeout: 30_000 }), page.getByText(/Listed\. PayOnce/).waitFor({ timeout: 30_000 })]).catch(() => {});
    if (await page.locator('#list-seller').isVisible().catch(() => false)) await page.locator('#list-seller').click();
    await page.getByText(/Listed\. PayOnce/).waitFor({ timeout: 180_000 });
    console.log(JSON.stringify({ step: 'listed' }));
    await shot('4-listed');
    // 6. invoice
    await page.getByLabel(/What is it for/).fill('QA invoice');
    await page.locator('#create-invoice').click();
    await page.locator('#agent-pay').waitFor({ timeout: 240_000 });
    console.log(JSON.stringify({ step: 'invoice ok' }));
    await shot('5-invoice');
    await page.locator('#agent-pay').click();
    await page.getByText(/Paid by PayOnce/).waitFor({ timeout: 300_000 });
    await shot('6-paid');
    console.log(JSON.stringify({ ok: true, flow, seconds: Math.round((Date.now() - t0) / 1000), txs: log }));
  }
} catch (e) {
  await shot('fail');
  console.log(JSON.stringify({ ok: false, flow, error: String(e?.message ?? e).slice(0, 300), txs: log }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
