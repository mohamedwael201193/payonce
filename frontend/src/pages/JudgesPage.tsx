// "For judges" panel — P3 §17. Contracts, transactions, verifier re-run,
// known limits, build status, downloads. Every link uses the
// /testnet/transaction/ pattern (never the plural /transactions/ path).
// All transaction hashes below are the real recorded hashes from PAYABLE_LOG.md
// as cited in P3 §17.
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
  { label: 'CCD — payable 1 registered', hash: 'd898683668cd8d55fdb2c0ab2505c2d547e137b7955e131b8863d82ad01efb2d' },
  { label: 'CCD — payable 1 paid', hash: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6' },
  { label: 'CCD — second payment refused (-5)', hash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848' },
  { label: 'CCD — wrong amount refused (-6)', hash: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c' },
  { label: 'CCD — unknown id refused (-3)', hash: 'd906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28' },
  { label: 'CCD — payable 4 paid', hash: '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e' },
  { label: 'EUDemo — reserve', hash: 'ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1' },
  { label: 'EUDemo — co-signed transfer, memo payable:2', hash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' },
  { label: 'EUDemo — second reservation refused (-16)', hash: 'ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35' },
  { label: 'EUDemo — confirm by seller', hash: '212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde' },
  { label: 'EUDemo — reused hash refused (-12)', hash: '02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b' },
  { label: 'EUDemo — stranger confirm refused (-17)', hash: '8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a' },
  { label: 'EUDemo — expiry inside window refused (-13)', hash: '8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7' },
  { label: 'EUDemo — expiry after window', hash: '492607926c88c3d9bdcad4edaebd8298c48668d7ee22a0d367cf74b6cdba0760' },
]

const KNOWN_LIMITS = [
  'Only the CCD route moves money inside the contract’s own transaction. The EUDemo route depends on the co-signer’s decision and on the node’s 2-of-3 rule. The contract cannot see PLT transfers.',
  'H1: anyone can register a payable from a seller account that holds an Active agent token. The chain accepts it. The co-signer also approves a registered EUDemo payable without a vendor list. The vendor list is checked only by this web app before its pay buttons. A judge who pays through another client is not stopped.',
  'H2: on the EUDemo route, confirm_plt records a payer-asserted transaction hash. The contract checks only that it is unused. The seller reads “paid” from the status, which is the weak spot. The verifier, not the status, is the check to trust.',
  'Race: if a transfer finalises but its confirm lands after a third party releases the reservation, the invoice can be paid again. The co-signer’s 60 s margin is in place. The transaction-expiry bound is not built.',
  'Seller identity: no LEI and no company proof. The seller’s agent is on our test instance, not on the official registry.',
  'One lab identity seed and one machine hold the keys. The co-signer is a function inside the lab server, not a separate service.',
  'Gas for the agent wallet is paid by the lab seller account.',
  'Refused transactions still cost a fee. The fee for a successful CCD payment (16.2 testnet CCD in the run) is larger than the 0.5 CCD invoice. These are testnet fees, not mainnet estimates.',
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
                <a href={`${INST_BASE}13149/0`} target="_blank" rel="noreferrer" className="font-medium text-teal-700">
                  &lt;13149,0&gt; on the explorer
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Module ref</dt>
              <dd className="font-mono text-xs text-ink break-all">
                9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24
              </dd>
            </div>
            <div>
              <dt className="text-muted">Module deploy transaction (409.514174 testnet CCD)</dt>
              <dd>
                <HashLink hash="94987a8e9e31432ca63c84c775982790c158218c296dcf1638fa00116a58eb2e" explorerBase={TX_BASE} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Init transaction (7.751697 testnet CCD)</dt>
              <dd>
                <HashLink hash="3ee0408419e0d340336653fae5e301ad09e702f5b8a3094f763eb3aaea1c5721" explorerBase={TX_BASE} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Test CIS-8004 instance</dt>
              <dd>
                <a href={`${INST_BASE}13144/0`} target="_blank" rel="noreferrer" className="font-medium text-teal-700">
                  &lt;13144,0&gt; on the explorer
                </a>{' '}
                <span className="text-muted">
                  — our instance of the official module, with lab tokens. It is not the official registry &lt;12802,0&gt;.
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
              Requirements: Node.js, and the packages the script imports (@concordium/web-sdk 12.0.3, @grpc/grpc-js).
              The script was run from the lab folder on 24 Nov 2026. A standalone copy needs its own npm install;
              packaging is not done.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-ink p-4 font-mono text-[13px] leading-relaxed text-paper">
              {`node verify-payable.mjs 2 7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef
node verify-payable.mjs 1 00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6`}
            </pre>
            <p className="mt-3 text-muted">
              Expected output: <code className="font-mono text-ink">ALL CHECKS PASS (12/12)</code> for payable 2,{' '}
              <code className="font-mono text-ink">(10/10)</code> for payable 1. Payable 2 was re-run on 24 Nov:
              12/12, 13.6 s. Payable 1 is from the log, not re-run for this spec.
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
            26 Rust integration tests pass (<code className="font-mono text-ink">cargo test --release</code> in{' '}
            <code className="font-mono text-ink">contracts/payable_registry</code>). Co-signer refusal cases: 7 (no
            transaction).
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
