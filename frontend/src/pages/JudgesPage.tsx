// "For judges" panel — P3 §17. Contracts, transactions, verifier re-run,
// known limits, build status, downloads. Every link uses the
// /testnet/transaction/ pattern (never the plural /transactions/ path).
// All transaction hashes below are real recorded hashes from the v2 live
// runs (contracts/CONTRACT_REPORT.md §4, backend/BACKEND_REPORT.md §6,
// api/API_REPORT.md §5). The registry is v2 <13150,0>.
import { useConfig } from '../hooks/useApi'
import { api } from '../lib/api'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AppHeader } from '../components/AppHeader'
import { Footer } from '../components/Sections'
import { HashLink } from '../components/ui'
import { useSlowLoad } from '../components/polish'
import { BANNED_WORDS, GLOSSARY, buildStatusString, buildStatusText, coSignerRunsAsSentence, reservationDefinition } from '../lib/copy'

const TX_BASE = 'https://ccdexplorer.io/testnet/transaction/'
const INST_BASE = 'https://ccdexplorer.io/testnet/instance/'

const SAMPLE_TXS: Array<{ label: string; hash: string }> = [
  { label: 'CCD — payable 10 registered', hash: 'e36da695159bfb809d96b732c9d056cead0ccf357e4a2a763ccc801625b606f9' },
  { label: 'CCD — payable 10 paid', hash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197' },
  { label: 'CCD — second payment refused (-5)', hash: '7d37ec8e82fdc02192ffa3d14f794174fbf8ceee849f5bdb28b107b84199dd72' },
  { label: 'CCD — wrong amount refused (-6)', hash: '925993da7905ddee5f74d0a133d20299d4fbb010c9998acb11e558d5cdf704f2' },
  { label: 'CCD — unknown id refused (-3)', hash: '780bd33bc5a6af120b06242d5be8a43792e1b54bd3fa701031ab09d5a47613e3' },
  { label: 'EUDemo — payable 11 registered', hash: '129f8943fd5c8a08241fe608899792acde712fe1ae3d9ee1d0eb067d2a790851' },
  { label: 'EUDemo — reserve (by the payer)', hash: 'a36aa1e0d2ea71a4702075cd0d94752fac7f088dfb52d4038322b7e617180f0d' },
  { label: 'EUDemo — co-signed transfer, memo payable:<owner>:11', hash: '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214' },
  { label: 'EUDemo — confirm by the reserving payer', hash: 'adf55f61c1345d14f05c6c0ee59b996dae8aaef06213e485a17cfb96376100c2' },
  { label: 'EUDemo — confirm by the wrong account refused (-17)', hash: '7ded67fd78341574bb64b68adf21197ccad3ba1cd88f6ce1edcf55db94bdcc37' },
  { label: 'EUDemo — reserve by the wrong payer refused (-21)', hash: '00f6cbd5271fd233861b4704c1a98c5d5fb3b308e8a5d35a1803af11758bed2e' },
  { label: 'EUDemo — register without expected payer refused (-22)', hash: 'ac9eab3c75fbfc5604a2b2173c2c2d85b6496d842bec8320c4f76c1c8fecd543' },
]

const KNOWN_LIMITS = [
  'Only the CCD route moves money inside the contract’s own transaction. The EUDemo route depends on the co-signer’s decision and on the node’s 2-of-3 rule. The contract cannot see PLT transfers.',
  'H1: the vendor list is on chain — buyer B approved the demo seller (tier 2, 100 CCD per payable, 1,000 CCD per day, 24 h period) — and the co-signer refuses any payable whose seller is not on it (live dry run on the dashboard, code no-approval). On the EUDemo rail the chain refuses an unlisted seller too (−19: reserve_plt always needs an approval row). On the CCD rail the chain refuses only in strict mode (−19), and strict mode is off in this demo run, so a CCD payment to an unlisted seller is not stopped on chain.',
  'H2: on the EUDemo route the seller names the expected payer at registration, and only the reserving payer can confirm — a confirm from any other account reverts (−17, proven live in the smoke run). The contract still cannot see the PLT transfer itself, so the verifier — not the status — is the check to trust: it re-reads the transfer (payee, amount, memo) from the chain.',
  'Race: the co-signer co-signs only while at least 60 s of the reservation remain and binds the transfer’s header expiry to reservation expiry − 60 s. A transfer that finalises after a third party releases the reservation can still only be confirmed by the reserving payer while the reservation is live.',
  'Seller identity: the seller holds an Active agent token (1476) on the official registry <12802,0>, cross-checked by the contract at registration and at payment. No LEI and no company proof — the seller is the owner’s own identity, not a company. The company-identity check runs in the verifier, not in the contract (contracts cannot verify V&A proofs).',
  'One testnet seed holds the keys (in-process, testnet only; a new seed is required before any publish). The co-signer is a decision gate inside this API server, not a separate service on a separate host.',
  'Each party pays its own testnet fees (no sponsored transactions in this demo run).',
  'Refused transactions still cost a fee. The fee for a successful CCD payment (19.6 testnet CCD in the v2 run) is larger than the 0.5 CCD invoice. Fees vary per transaction. These are testnet fees, not mainnet estimates.',
  'Payables expire at their due date (about 24 hours after registration). Demo invoices must be fresh on the day.',
  'Testnet only. EUDemo is a testnet demo token. Invoices are lab documents.',
  'Not in this flow: age proof for alcohol and similar. The consent anchor IS in this flow now: an above-threshold payment (1 CCD / 1.00 EUDemo or more) refuses until the owner approves a hash-bound question, anchored on chain as a VRA/VAA registerData pair (see “Consent anchor” below). Age proof stays out — it comes from an earlier lab phase.',
]

export function JudgesPage() {
  const config = useConfig()
  const files = useQuery({ queryKey: ['judge-files'], queryFn: api.getJudgeFiles, retry: 1 })
  const filesSlow = useSlowLoad(files.isLoading)
  const build = config.data?.build

  return (
    <div className="page-enter min-h-screen bg-paper">
      <div className="bg-sky-0">
        <AppHeader dark />
      </div>
      <main id="main" className="mx-auto max-w-[860px] px-4 py-12 sm:px-6">
        <p>
          <Link to="/" className="font-medium text-brand-700">
            ← Back to home
          </Link>
        </p>
        <h1 className="mt-4 text-[32px] leading-[1.1] font-medium tracking-[-0.02em] text-ink">For judges</h1>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.5] text-muted">
          Everything on this page can be checked without us: contracts and transactions on the explorer, and a keyless
          verifier you can run yourself. No keys, no .env, read-only.
        </p>

        <section aria-labelledby="on-chain" className="mt-10">
          <h2 id="on-chain" className="text-xl font-medium text-ink">
            What is on chain
          </h2>
          <dl className="mt-4 space-y-3 rounded-none border border-line bg-card p-6 text-sm">
            <div>
              <dt className="text-muted">Payable registry</dt>
              <dd>
                <a href={`${INST_BASE}13150/0`} target="_blank" rel="noreferrer" className="font-medium text-brand-700">
                  &lt;13150,0&gt; on the explorer
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Module ref</dt>
              <dd className="font-mono text-xs text-ink break-all">
                c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8
              </dd>
            </div>
            <div>
              <dt className="text-muted">Module deploy transaction (612.779703 testnet CCD)</dt>
              <dd>
                <HashLink hash="edb6d1af6166f3e17fe4623c1af85d41bc2020b09d8773a380be8e018dc6e5f3" explorerBase={TX_BASE} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Init transaction (8.234425 testnet CCD)</dt>
              <dd>
                <HashLink hash="50d007af74c64a20d280afff20276c49e379188c764564a43695cbce2370ee50" explorerBase={TX_BASE} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Official CIS-8004 registry</dt>
              <dd>
                <a href={`${INST_BASE}12802/0`} target="_blank" rel="noreferrer" className="font-medium text-brand-700">
                  &lt;12802,0&gt; on the explorer
                </a>{' '}
                <span className="text-muted">
                  — the official registry. The seller’s agent token 1476 is registered there (Active, owned by the
                  deployer) and is cross-checked by the contract at registration and at payment.
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">What the badge proves</dt>
              <dd>
                Badge = a verified human stands behind this agent. Spending is gated by the on-chain mandate, not by
                the badge. The badge proves accountability only — never spending permission, code quality, or
                reputation.
              </dd>
            </div>
            <div>
              <dt className="text-muted">Payment address</dt>
              <dd>
                Payment goes to the merchant account recorded on the payable, not necessarily the registry owner. The
                badge check does not link the payment address to the owner — live example: CCD payee{' '}
                <code className="font-mono text-xs text-ink">4gedLUop…</code> vs registry owner{' '}
                <code className="font-mono text-xs text-ink">42jaZZgd…</code>.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="verify-pay" className="mt-10">
          <h2 id="verify-pay" className="text-xl font-medium text-ink">
            Verify &amp; Pay
          </h2>
          <div className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <p className="text-muted">
              This is Concordium’s name for the flow: verify first, then pay once. The two checks are (1) verify the
              seller and the invoice — the verifier re-reads the registry, the badge, and the document from the chain
              — and (2) pay exactly once, to the account the supplier put on the payable. Nothing is delivered before
              both pass.
            </p>
            <h3 className="mt-5 font-medium text-ink">Consent anchor (ask-me threshold)</h3>
            <p className="mt-2 text-muted">
              A payment at or above 1 CCD / 1.00 EUDemo refuses until the owner approves a hash-bound question. The
              approval is anchored on chain as a VRA/VAA registerData pair (CBOR, type CCD-VRA / CCD-VAA), and the
              receipt check verifies the anchor exists and matches. Below the threshold no consent is needed. The
              approval is one-time use and expires after 5 minutes. Live anchors:
            </p>
            <ul className="mt-3 space-y-2">
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">Consent VRA — payable 2000 (2.00 EUDemo)</span>
                <HashLink hash="6edb6e5497d5bf1aed822ac67fc7cca17aa9f16aef9b0be12e372b30a77f3849" explorerBase={TX_BASE} />
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">Consent VRA — payable 2001 (2.00 EUDemo)</span>
                <HashLink hash="03daeba1a57daca2df7bf5c8faa094a9ce7a921a316a0d2ca3a2212ac4e754fc" explorerBase={TX_BASE} />
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">Consent VAA — payable 2001 (approved)</span>
                <HashLink hash="df08af0f81f8902527c9a14f18b655a73196be9bd3c1a87ee2c0945c1c28ecf5" explorerBase={TX_BASE} />
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">Lab consent VRA — goal 2 (earlier run)</span>
                <HashLink hash="ed92afaf8b3a7806a838f96d210ae2b0ffce9769297fa38973462b1a933bee00" explorerBase={TX_BASE} />
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">Lab consent VAA — goal 2 (earlier run)</span>
                <HashLink hash="2b3e6ddd84bd6a23ccb8ec395a647ed7c91c1b700cc8c751fcf4f5a7f16cbc06" explorerBase={TX_BASE} />
              </li>
            </ul>
            <p className="mt-3 text-muted">
              Payable 2001 (2.00 EUDemo) went through the whole flow live: the pay endpoint refused with
              consent_required, the owner approved the hash-bound question (VRA/VAA above, node-verified), the
              payment went through (
              <HashLink hash="759f3a5e5035167a016bb8f974121dce297b35d9a35ef6d7a1b2e324e05de89f" explorerBase={TX_BASE} />
              ), and the receipt carries the Art. 12 record with nonce, record hash and a registerData anchor (
              <HashLink hash="0650d654328d423c3ae53d26afcb9258fc21ac8f23d83aaac5bbc64313324294" explorerBase={TX_BASE} />
              , verified on read-back) — receipt verifier 14/14. The consent was one-time use and is marked used.
            </p>
            <h3 className="mt-5 font-medium text-ink">Doris’s five checks, mapped to the receipt verifier</h3>
            <p className="mt-2 text-muted">
              The receipt verifier’s checks map onto the five checks like this — all five pass on the seller badge
              (token 1476), checked live through the registry MCP (network=testnet on every call):
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6 text-muted">
              <li>Registry — the agent is found on the official CIS-8004 registry &lt;12802,0&gt;: pass.</li>
              <li>Active — the agent status is Active, not revoked: pass.</li>
              <li>URL — the agent card is fetched from the published agent URI: pass.</li>
              <li>Hash — the fetched card’s SHA-256 matches the hash on chain: pass.</li>
              <li>Owner — the card owner matches the on-chain owner account: pass.</li>
            </ul>
            <p className="mt-3 text-muted">
              Second agent checked the same way: the buyer agent (token 1488, owner = the demo payer account). Registry:
              pass. Active: pass. Owner: pass. URL and hash: not run — the buyer agent has published no card or URI
              yet, so there is no card to fetch or hash; the merchant gate for it is Active + owner, stated plainly.
            </p>
          </div>
        </section>

        <section aria-labelledby="fees" className="mt-10">
          <h2 id="fees" className="text-xl font-medium text-ink">
            Fee table
          </h2>
          <div className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <p className="text-muted">
              Concordium’s fee peg is €0.01 per transaction. Every transaction in a payment is counted below, at the
              peg. Testnet CCD energy costs are a separate number and are larger — a successful CCD payment cost 19.6
              testnet CCD in the v2 run — and are not mainnet estimates.
            </p>
            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th className="py-2 pr-4 font-medium">Order flow</th>
                  <th className="py-2 pr-4 font-medium">Transactions counted</th>
                  <th className="py-2 font-medium">Total at the peg</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                <tr className="border-b border-line">
                  <td className="py-2 pr-4">CCD payment</td>
                  <td className="py-2 pr-4">register, pay, receipt anchor (3)</td>
                  <td className="py-2">€0.03</td>
                </tr>
                <tr className="border-b border-line">
                  <td className="py-2 pr-4">EUDemo payment</td>
                  <td className="py-2 pr-4">register, reserve, transfer, confirm, receipt anchor (5)</td>
                  <td className="py-2">€0.05</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">EUDemo payment, above the ask-me threshold</td>
                  <td className="py-2 pr-4">the 5 above + consent VRA + consent VAA (7)</td>
                  <td className="py-2">€0.07</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-muted">
              Reconciled against the €0.20–€0.30 per €12 basket estimate: that figure is not reproduced by counting
              this flow’s transactions — the longest flow here is 7 transactions, €0.07 at the peg. The estimate would
              need 20–30 transactions at the peg, or a per-transaction cost well above the peg.
            </p>
          </div>
        </section>

        <section aria-labelledby="path" className="mt-10">
          <h2 id="path" className="text-xl font-medium text-ink">
            Path to production
          </h2>
          <div className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <h3 className="font-medium text-ink">Euro rail: PLL migration</h3>
            <p className="mt-2 text-muted">
              Simple locks land January 2027: recipients, PLT-only (not CCD), expiry, grants that fund, send, release
              and cancel, plus keep-alive. Enhanced locks land March 2027: smart-contract-driven. Our mapping today:
              recipients = the merchant allow-list; tokens = EUDemo; expiry = the order window; send grant = the
              agent; fund grant = the owner; release and cancel = the owner. Until the locks land, our mandate
              contract is the on-chain version of the same controls.
            </p>
            <h3 className="mt-5 font-medium text-ink">Custody: what we use, what we don’t</h3>
            <p className="mt-2 text-muted">
              What we use in this demo: the owner’s recovery key stays in the user’s own wallet, never on the server;
              the agent acts through a headless credential of the human identity (the agent holds only the ZK proof,
              never the identity itself). What we don’t use: DFNS wallet-as-a-service (MPC, API signing) and Tether’s
              WDK branded wallet (human consent on the roadmap) — neither is integrated. The Agent IDP path (the agent
              holds only revealed attributes) is the team’s sanctioned direction, but its testnet status is unverified
              — no testnet endpoint or announcement exists — so no migration is claimed.
            </p>
            <h3 className="mt-5 font-medium text-ink">Onboarding</h3>
            <p className="mt-2 text-muted">
              Merchants and agents onboard to the live network without buying CCD first — registration is sponsored.
              Long-running work: payments here complete in seconds, so the long-running anchoring pattern (hash +
              anchor, or a longer expiry) does not apply to the current flow; the same registerData anchoring is what
              the consent VRA/VAA pair already uses. Second store: Varox (the programme’s V&amp;A partner) was
              evaluated and no public evidence of its API or demo exists, so we build V&amp;A V1 ourselves and keep
              Varox as the named partner option for the second store, contacted via the programme.
            </p>
            <h3 className="mt-5 font-medium text-ink">Security basis</h3>
            <p className="mt-2 text-muted">
              Concordium’s own chain was covered by a CertiK gray-box audit, December 2025 – May 2026: 13 findings, 2
              critical, all availability-related (chain stopping, never stolen funds or malicious accounting); most
              fixed, some acknowledged. That audit is of the chain, not of this demo.
            </p>
          </div>
        </section>

        <section aria-labelledby="sample-txs" className="mt-10">
          <h2 id="sample-txs" className="text-xl font-medium text-ink">
            Sample transactions
          </h2>
          <ul className="mt-4 space-y-2 rounded-none border border-line bg-card p-6 text-sm">
            {SAMPLE_TXS.map((t) => (
              <li key={t.hash} className="flex flex-wrap items-center gap-2">
                <span className="w-64 shrink-0 text-muted">{t.label}</span>
                <HashLink hash={t.hash} explorerBase={TX_BASE} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="verifier" className="mt-10">
          <h2 id="verifier" className="text-xl font-medium text-ink">
            Re-run the verifier yourself
          </h2>
          <div className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <p className="text-muted">
              Requirements: Node.js, and npm install in <code className="font-mono text-ink">api/</code> and in{' '}
              <code className="font-mono text-ink">backend/</code> (the script imports the backend modules from there).
              The script is read-only: no keys, no .env, no sends. It was run from the repo on 24 Nov 2026.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-ink p-4 font-mono text-[13px] leading-relaxed text-paper">
              {`cd api && npm install
cd ../backend && npm install
cd ../api
node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt
node src/verify-payable-v2.mjs 11 690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214 --doc ../backend/test/invoices/invoice-011-v2-eudemo.txt`}
            </pre>
            <p className="mt-3 text-muted">
              Expected output: <code className="font-mono text-ink">ALL CHECKS PASS (10/10)</code> for payable 10,{' '}
              <code className="font-mono text-ink">ALL CHECKS PASS (12/12)</code> for payable 11. Both were re-run on 24
              Nov 2026. Without <code className="font-mono text-ink">--doc</code> the document check is reported as
              NOT RUN, not as a failure.
            </p>
            <p className="mt-3 text-muted">
              Note: the invoice documents are read by the verifier for the document check. A missing file shows as a
              failed check in the script. The web page reports it as “not run” instead.
            </p>
            <h3 className="mt-5 font-medium text-ink">Download files</h3>
            {files.isError ? (
              <p className="mt-2 text-muted">The file list is not reachable right now.</p>
            ) : files.data ? (
              <ul className="mt-2 space-y-1">
                {files.data.map((f) => (
                  <li key={f.name}>
                    <a href={f.url} className="font-medium text-brand-700">
                      {f.name}
                    </a>{' '}
                    <span className="font-mono text-xs break-all text-muted">SHA-256: {f.sha256}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted" role="status">
                Loading the file list…{filesSlow ? ' Still loading — the test API is slow right now.' : ''}
              </p>
            )}
          </div>
        </section>

        <section aria-labelledby="tests" className="mt-10">
          <h2 id="tests" className="text-xl font-medium text-ink">
            Tests
          </h2>
          <p className="mt-4 rounded-none border border-line bg-card p-6 text-sm text-muted">
            80 Rust tests pass (<code className="font-mono text-ink">cargo concordium test</code> in{' '}
            <code className="font-mono text-ink">contracts/payable_registry_v2</code>). Co-signer decision cases: 35
            (pure function, no transaction). Backend suite: 175 tests. API server suite: 47 unit tests (consent,
            MCP client, balance watch, buyer agent, CIS-8, Art. 12 receipts, G7 fix-back-3–9 verifier checks) + live route proofs on a scratch server.
            Frontend suite: 155 tests.
          </p>
        </section>

        <section aria-labelledby="limits" className="mt-10">
          <h2 id="limits" className="text-xl font-medium text-ink">
            Known limits (said before a judge asks)
          </h2>
          <ul className="mt-4 list-disc space-y-2 rounded-none border border-line bg-card p-6 pl-10 text-sm text-muted">
            {KNOWN_LIMITS.map((l) => (
              <li key={l.slice(0, 40)}>{l}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="words" className="mt-10">
          <h2 id="words" className="text-xl font-medium text-ink">
            Words we do not use
          </h2>
          <dl className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            {BANNED_WORDS.map(({ word: w, reason }) => (
              <div key={w} className="flex gap-3 border-b border-line py-2 last:border-0">
                <dt className="w-48 shrink-0 font-medium text-ink">“{w}”</dt>
                <dd className="text-muted">{reason}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="build-status" className="mt-10">
          <h2 id="build-status" className="text-xl font-medium text-ink">
            Build status
          </h2>
          {/* B5: while /api/config loads, every row says "Loading…" — the old
              ternary rendered "Not yet (planned)" / "—" on first paint, so a
              judge capturing first paint got the wrong answer. */}
          <dl className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <div className="flex gap-3 py-1.5">
              <dt className="w-32 shrink-0 text-muted sm:w-72">Vendor list enforced by the co-signer</dt>
              <dd className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.vendor_list_enforced_by_co_signer)}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-32 shrink-0 text-muted sm:w-72">Named payer on invoice</dt>
              <dd className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.named_payer_on_invoice)}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-32 shrink-0 text-muted sm:w-72">Confirm by</dt>
              <dd className="text-ink">{buildStatusString(config.isLoading, config.isError, build?.confirm_by)}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-32 shrink-0 text-muted sm:w-72">Transaction expiry bounded by the reservation</dt>
              <dd className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.header_expiry_bound)}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-32 shrink-0 text-muted sm:w-72">Co-signer runs as</dt>
              <dd className="text-ink">{coSignerRunsAsSentence()}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="glossary" className="mt-10">
          <h2 id="glossary" className="text-xl font-medium text-ink">
            Glossary
          </h2>
          <dl className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            {GLOSSARY.map(([term, def]) => (
              <div key={term} className="flex gap-3 border-b border-line py-2 last:border-0">
                <dt className="w-32 shrink-0 font-medium text-ink">{term}</dt>
                {/* B4: the Reservation length comes from /api/config, never
                    from the static string — one true number everywhere. */}
                <dd className="text-muted">{term === 'Reservation' ? reservationDefinition(config.data?.reservation_secs) : def}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
      <Footer />
    </div>
  )
}
