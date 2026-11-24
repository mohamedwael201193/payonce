// "For judges" panel — P3 §17. Contracts, transactions, verifier re-run,
// known limits, build status, downloads. Every link uses the
// /testnet/transaction/ pattern (never the plural /transactions/ path).
// All transaction hashes below are real recorded hashes from the v2 live
// runs (contracts/CONTRACT_REPORT.md §4, backend/BACKEND_REPORT.md §6,
// api/API_REPORT.md §5). The registry is v2 <13150,0>.
import { useConfig } from '../hooks/useApi'
import { api } from '../lib/api'
import { useQuery } from '@tanstack/react-query'
import { AppHeader } from '../components/AppHeader'
import { Footer } from '../components/Sections'
import { HashLink } from '../components/ui'
import { BANNED_WORDS, GLOSSARY } from '../lib/copy'

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
  'Refused transactions still cost a fee. The fee for a successful CCD payment (19.6 testnet CCD in the v2 run) is larger than the 0.5 CCD invoice. These are testnet fees, not mainnet estimates.',
  'Payables expire at their due date (about 24 hours after registration). Demo invoices must be fresh on the day.',
  'Testnet only. EUDemo is a testnet demo token. Invoices are lab documents.',
  'Not in this flow: age proof for alcohol and similar, consent anchor (V&A). Both come from earlier lab phases and are not part of this idea’s flow.',
]

export function JudgesPage() {
  const config = useConfig()
  const files = useQuery({ queryKey: ['judge-files'], queryFn: api.getJudgeFiles, retry: 1 })
  const build = config.data?.build

  return (
    <div className="min-h-screen bg-paper">
      <div className="bg-sky-0">
        <AppHeader dark />
      </div>
      <main id="main" className="mx-auto max-w-[860px] px-4 py-12 sm:px-6">
        <h1 className="text-[32px] leading-[1.1] font-medium tracking-[-0.02em] text-ink">For judges</h1>
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
                <a href={`${INST_BASE}13150/0`} target="_blank" rel="noreferrer" className="font-medium text-teal-700">
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
                <a href={`${INST_BASE}12802/0`} target="_blank" rel="noreferrer" className="font-medium text-teal-700">
                  &lt;12802,0&gt; on the explorer
                </a>{' '}
                <span className="text-muted">
                  — the official registry. The seller’s agent token 1476 is registered there (Active, owned by the
                  deployer) and is cross-checked by the contract at registration and at payment.
                </span>
              </dd>
            </div>
          </dl>
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
                    <a href={f.url} className="font-medium text-teal-700">
                      {f.name}
                    </a>{' '}
                    <span className="font-mono text-xs text-muted">SHA-256: {f.sha256}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted" role="status">
                Loading the file list…
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
            (pure function, no transaction). Backend suite: 110 tests. API server suite: 26 tests (unit 10 + live
            read-only 16).
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
          <dl className="mt-4 rounded-none border border-line bg-card p-6 text-sm">
            <div className="flex gap-3 py-1.5">
              <dt className="w-72 shrink-0 text-muted">Vendor list enforced by the co-signer</dt>
              <dd className="text-ink">{build?.vendor_list_enforced_by_co_signer ? 'Yes' : 'Not yet (planned)'}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-72 shrink-0 text-muted">Named payer on invoice</dt>
              <dd className="text-ink">{build?.named_payer_on_invoice ? 'Yes' : 'Not yet (planned)'}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-72 shrink-0 text-muted">Confirm by</dt>
              <dd className="text-ink">{build?.confirm_by ?? '—'}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-72 shrink-0 text-muted">Transaction expiry bounded by the reservation</dt>
              <dd className="text-ink">{build?.header_expiry_bound ? 'Yes' : 'Not yet (planned)'}</dd>
            </div>
            <div className="flex gap-3 py-1.5">
              <dt className="w-72 shrink-0 text-muted">Co-signer runs as</dt>
              <dd className="text-ink">{build?.co_signer_runs_as ?? '—'}</dd>
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
                <dd className="text-muted">{def}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
      <Footer />
    </div>
  )
}
