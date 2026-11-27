// For judges, inside the app shell. Everything here can be checked without
// us: contracts and transactions on the explorer, and a keyless verifier
// command. Recorded transactions are labelled recorded; build status is
// read live from /api/config. No test count is typed here: the suites are
// listed as commands to run.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { BANNED_WORDS, GLOSSARY, buildStatusString, buildStatusText, coSignerRunsAsSentence, reservationDefinition } from '../../lib/copy'
import { EXPLORER_INSTANCE } from '../../lib/tokens'
import { useConfig } from '../../hooks/useApi'
import { ccdPayFeeSentence, recordedLabel } from '../fees'
import { useDocumentTitle } from '../hooks'
import { verifierCommand } from '../verifier'
import { Card, CopyButton, ExplorerTx, KeyValue, PageHeader, Skeleton, useExplorerBase } from '../ui'
import type { ReactNode } from 'react'
import { RECORDED_DATE } from '../../lib/recorded'
import { Address } from '../Address'

const SAMPLE_TXS: Array<{ label: string; hash: string }> = [
  { label: 'CCD, payable 10 registered', hash: 'e36da695159bfb809d96b732c9d056cead0ccf357e4a2a763ccc801625b606f9' },
  { label: 'CCD, payable 10 paid', hash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197' },
  { label: 'CCD, second payment refused (-5)', hash: '7d37ec8e82fdc02192ffa3d14f794174fbf8ceee849f5bdb28b107b84199dd72' },
  { label: 'CCD, wrong amount refused (-6)', hash: '925993da7905ddee5f74d0a133d20299d4fbb010c9998acb11e558d5cdf704f2' },
  { label: 'CCD, unknown id refused (-3)', hash: '780bd33bc5a6af120b06242d5be8a43792e1b54bd3fa701031ab09d5a47613e3' },
  { label: 'EUDemo, payable 11 registered', hash: '129f8943fd5c8a08241fe608899792acde712fe1ae3d9ee1d0eb067d2a790851' },
  { label: 'EUDemo, reserve by the payer', hash: 'a36aa1e0d2ea71a4702075cd0d94752fac7f088dfb52d4038322b7e617180f0d' },
  { label: 'EUDemo, co-signed transfer', hash: '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214' },
  { label: 'EUDemo, confirm by the reserving payer', hash: 'adf55f61c1345d14f05c6c0ee59b996dae8aaef06213e485a17cfb96376100c2' },
  { label: 'EUDemo, confirm by the wrong account refused (-17)', hash: '7ded67fd78341574bb64b68adf21197ccad3ba1cd88f6ce1edcf55db94bdcc37' },
  { label: 'EUDemo, reserve by the wrong payer refused (-21)', hash: '00f6cbd5271fd233861b4704c1a98c5d5fb3b308e8a5d35a1803af11758bed2e' },
  { label: 'EUDemo, register without expected payer refused (-22)', hash: 'ac9eab3c75fbfc5604a2b2173c2c2d85b6496d842bec8320c4f76c1c8fecd543' },
]

const CONSENT_TXS: Array<{ label: string; hash: string }> = [
  { label: 'Consent VRA, payable 2000 (2.00 EUDemo)', hash: '6edb6e5497d5bf1aed822ac67fc7cca17aa9f16aef9b0be12e372b30a77f3849' },
  { label: 'Consent VRA, payable 2001 (2.00 EUDemo)', hash: '03daeba1a57daca2df7bf5c8faa094a9ce7a921a316a0d2ca3a2212ac4e754fc' },
  { label: 'Consent VAA, payable 2001 (approved)', hash: 'df08af0f81f8902527c9a14f18b655a73196be9bd3c1a87ee2c0945c1c28ecf5' },
  { label: 'Payment of payable 2001', hash: '759f3a5e5035167a016bb8f974121dce297b35d9a35ef6d7a1b2e324e05de89f' },
  { label: 'Receipt anchor of payable 2001', hash: '0650d654328d423c3ae53d26afcb9258fc21ac8f23d83aaac5bbc64313324294' },
]

const KNOWN_LIMITS = [
  'Only the CCD route moves money inside the contract’s own transaction. The EUDemo route depends on the co-signer’s decision and on the node’s 2-of-3 rule. The contract cannot see PLT transfers.',
  'The vendor list is on chain, and the co-signer refuses any payable whose seller is not on it. On the EUDemo rail the chain refuses an unlisted seller too (-19: reserve_plt always needs an approval row). On the CCD rail the chain refuses only in strict mode (-19), and strict mode is off in this demo run, so a CCD payment to an unlisted seller is not stopped on chain. You can see the co-signer’s rule on Break it.',
  'On the EUDemo route the seller names the expected payer at registration, and only the reserving payer can confirm: a confirm from any other account reverts (-17). The contract still cannot see the PLT transfer itself, so the verifier, not the status, is the check to trust: it re-reads the transfer (payee, amount, memo) from the chain.',
  'Race: the co-signer co-signs only while at least 60 s of the reservation remain, and binds the transfer’s header expiry to the reservation expiry minus 60 s.',
  'Seller identity: the seller holds an Active agent token on the official registry <12802,0>, cross-checked by the contract at registration and at payment. There is no LEI and no company proof: the seller is the owner’s own identity, not a company.',
  'One testnet seed holds the keys (in-process, testnet only). The co-signer is a decision gate inside this API server, not a separate service on a separate host.',
  'This API signs payments only for seller 1. Reads, checks and receipts work for every seller; a seller-2 payment is not implemented yet.',
  'Refused transactions still cost a fee. Fees vary per transaction. These are testnet fees, not mainnet estimates.',
  'Payables expire at their due date (about 24 hours after registration). Demo invoices must be fresh on the day.',
  'Testnet only. EUDemo is a testnet demo token. Invoices are lab documents.',
  'Age proof is a separate flow. Payments of 1 CCD or 1.00 EUDemo and up refuse until the owner approves a hash-bound question (the consent anchor), and the age proof needs the prover sidecar on the API host.',
]

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
        {title}
      </h2>
      {children}
    </Card>
  )
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-[10px] border border-po-line bg-po-paper px-4">
      <summary className="flex min-h-[48px] cursor-pointer items-center font-medium text-po-ink">{title}</summary>
      <div className="flex flex-col gap-3 pb-4 text-[15px] text-po-grey">{children}</div>
    </details>
  )
}

export function JudgesPage() {
  useDocumentTitle('For judges - PayOnce')
  const config = useConfig()
  const explorer = useExplorerBase()
  const files = useQuery({ queryKey: ['judge-files'], queryFn: api.getJudgeFiles, retry: 1 })
  const build = config.data?.build
  const instBase = config.data?.explorer.instance ?? EXPLORER_INSTANCE
  const reg = config.data?.registry
  const official = config.data?.cis8004_test_instance

  const sampleCmd = verifierCommand({
    payableId: 10,
    txHash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197',
    docPath: '../backend/test/invoices/invoice-010-v2-ccd.txt',
  })
  const sampleCmd2 = verifierCommand({
    payableId: 11,
    txHash: '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214',
    docPath: '../backend/test/invoices/invoice-011-v2-eudemo.txt',
  })
  const setup = 'cd api && npm install\ncd ../backend && npm install\ncd ../api'
  const commands = `${setup}\n${sampleCmd}\n${sampleCmd2}`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="For judges"
        lead="Everything on this page can be checked without us: contracts and transactions on the explorer, and a keyless verifier you run yourself. No keys, no .env, read-only."
      />

      <Section id="verify-it" title="Verify one payment yourself">
        <p className="text-[15px] text-po-grey">
          The verifier is read-only. It re-reads the registry, the badge and the transfer from the chain. Without{' '}
          <code className="po-hash">--doc</code> the document check is reported as not run, not as a failure.
        </p>
        <pre className="overflow-x-auto rounded-[10px] bg-po-ink p-4 font-mono text-[13px] leading-relaxed text-po-paper" data-testid="judges-commands">
          {commands}
        </pre>
        <div>
          <CopyButton value={commands} label="commands" />
        </div>
        <p className="text-[15px] text-po-grey">
          Expected output: <code className="po-hash">ALL CHECKS PASS (10/10)</code> for payable 10 and{' '}
          <code className="po-hash">ALL CHECKS PASS (12/12)</code> for payable 11. {recordedLabel(RECORDED_DATE)}.
        </p>
        <p className="text-[15px] text-po-grey">
          To check a payment from this app, open its receipt: it prints the same command with that payment&apos;s hash.{' '}
          <Link to="/app/invoices" className="font-medium text-po-accent-ink underline decoration-po-line-strong">
            Open the invoices
          </Link>
        </p>
      </Section>

      <Section id="on-chain" title="What is on chain">
        {config.isLoading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : (
          <dl className="divide-y divide-po-line">
            <KeyValue label="Payable registry">
              {reg ? (
                <a href={`${instBase}${reg.index}/${reg.subindex}`} target="_blank" rel="noreferrer" className="font-medium text-po-accent-ink underline decoration-po-line-strong">
                  &lt;{reg.index},{reg.subindex}&gt; on the explorer
                </a>
              ) : (
                'Not loaded. The API did not answer.'
              )}
            </KeyValue>
            <KeyValue label="Module reference">
              {reg?.module_ref ? <Address value={reg.module_ref} kind="hash" label="module reference" expandable /> : 'Not loaded.'}
            </KeyValue>
            <KeyValue label="Official CIS-8004 registry">
              {official ? (
                <>
                  <a href={`${instBase}${official.index}/${official.subindex}`} target="_blank" rel="noreferrer" className="font-medium text-po-accent-ink underline decoration-po-line-strong">
                    &lt;{official.index},{official.subindex}&gt; on the explorer
                  </a>
                  . The seller agent tokens are registered there and cross-checked by the contract at registration and at payment.
                </>
              ) : (
                'Not loaded.'
              )}
            </KeyValue>
            <KeyValue label="Module deploy transaction">
              <ExplorerTx hash="edb6d1af6166f3e17fe4623c1af85d41bc2020b09d8773a380be8e018dc6e5f3" base={explorer} />
            </KeyValue>
            <KeyValue label="Init transaction">
              <ExplorerTx hash="50d007af74c64a20d280afff20276c49e379188c764564a43695cbce2370ee50" base={explorer} />
            </KeyValue>
            <KeyValue label="What the badge proves">
              A verified human stands behind this agent. Spending is gated by the on-chain mandate, not by the badge. The badge proves accountability only, never spending permission, code quality, or reputation.
            </KeyValue>
          </dl>
        )}
      </Section>

      <Section id="sample-txs" title="Sample transactions">
        <p className="text-[15px] text-po-grey">{recordedLabel(RECORDED_DATE)}. Every link opens the testnet explorer.</p>
        <ul className="divide-y divide-po-line">
          {SAMPLE_TXS.map((t) => (
            <li key={t.hash} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
              <span className="text-[15px] text-po-ink">{t.label}</span>
              <ExplorerTx hash={t.hash} base={explorer} />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="more" title="Consent, fees and the road to production">
        <Fold title="Verify and Pay, and the consent anchor">
          <p>
            Verify and Pay is Concordium&apos;s name for the flow: verify first, then pay once. The two checks are (1) verify the seller and the invoice, which the verifier does by re-reading the registry, the badge, and the document from the chain, and (2) pay exactly once, to the account the supplier put on the payable.
          </p>
          <p>
            A payment at or above 1 CCD or 1.00 EUDemo refuses until the owner approves a hash-bound question. The approval is anchored on chain as a VRA and VAA registerData pair, and the receipt check verifies the anchor exists and matches. It is one-time use and expires after 5 minutes. Live anchors:
          </p>
          <ul className="divide-y divide-po-line">
            {CONSENT_TXS.map((t) => (
              <li key={t.hash} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                <span className="text-po-ink">{t.label}</span>
                <ExplorerTx hash={t.hash} base={explorer} />
              </li>
            ))}
          </ul>
        </Fold>
        <Fold title="Fee table">
          <p>
            Concordium&apos;s fee peg is 0.01 euro per transaction. Every transaction in a payment is counted at the peg. Testnet CCD energy costs are a separate, larger number. {ccdPayFeeSentence()}
          </p>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-po-line text-po-grey">
                <th className="py-2 pr-4 font-medium">Flow</th>
                <th className="py-2 pr-4 font-medium">Transactions counted</th>
                <th className="py-2 font-medium">At the peg</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-po-line">
                <td className="py-2 pr-4">CCD payment</td>
                <td className="py-2 pr-4">register, pay, receipt anchor (3)</td>
                <td className="py-2">0.03 euro</td>
              </tr>
              <tr className="border-b border-po-line">
                <td className="py-2 pr-4">EUDemo payment</td>
                <td className="py-2 pr-4">register, reserve, transfer, confirm, receipt anchor (5)</td>
                <td className="py-2">0.05 euro</td>
              </tr>
              <tr>
                <td className="py-2 pr-4">EUDemo, above the ask-me threshold</td>
                <td className="py-2 pr-4">the 5 above, plus consent VRA and VAA (7)</td>
                <td className="py-2">0.07 euro</td>
              </tr>
            </tbody>
          </table>
        </Fold>
        <Fold title="Path to production">
          <p>
            Euro rail: simple locks land January 2027 and enhanced locks March 2027. Until then, our mandate contract is the on-chain version of the same controls: recipients are the merchant allow-list, the token is EUDemo, and expiry is the order window.
          </p>
          <p>
            What we use in this demo: the owner&apos;s recovery key stays in the user&apos;s own wallet, never on the server, and the agent holds only a zero-knowledge proof, never the identity itself. What we do not use: DFNS wallet-as-a-service and Tether&apos;s WDK branded wallet. Neither is integrated.
          </p>
          <p>
            Concordium&apos;s own chain was covered by a CertiK gray-box audit, December 2025 to May 2026: 13 findings, 2 critical, all availability-related. That audit is of the chain, not of this demo.
          </p>
        </Fold>
      </Section>

      <Section id="limits" title="Known limits">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] text-po-grey">
          {KNOWN_LIMITS.map((l) => (
            <li key={l.slice(0, 40)}>{l}</li>
          ))}
        </ul>
        <p className="text-[15px] text-po-grey" data-testid="fee-limit">
          {ccdPayFeeSentence()}
        </p>
      </Section>

      <Section id="build-status" title="Build status, read live">
        <dl className="divide-y divide-po-line">
          <KeyValue label="Vendor list enforced by the co-signer">
            {buildStatusText(config.isLoading, config.isError, build?.vendor_list_enforced_by_co_signer)}
          </KeyValue>
          <KeyValue label="Named payer on invoice">{buildStatusText(config.isLoading, config.isError, build?.named_payer_on_invoice)}</KeyValue>
          <KeyValue label="Confirm by">{buildStatusString(config.isLoading, config.isError, build?.confirm_by)}</KeyValue>
          <KeyValue label="Transaction expiry bounded by the reservation">
            {buildStatusText(config.isLoading, config.isError, build?.header_expiry_bound)}
          </KeyValue>
          <KeyValue label="Co-signer runs as">{coSignerRunsAsSentence()}</KeyValue>
        </dl>
      </Section>

      <Section id="tests" title="Run the tests yourself">
        <p className="text-[15px] text-po-grey">No count is printed here, because a printed count goes stale. Each suite prints its own.</p>
        <pre className="overflow-x-auto rounded-[10px] bg-po-ink p-4 font-mono text-[13px] leading-relaxed text-po-paper">{`cd frontend && npm test
cd api && npm run test:unit
cd backend && node --test test/*.test.mjs
node --test contracts/cosigner/test/decide.test.mjs
cd contracts/payable_registry_v2_1 && cargo concordium test`}</pre>
      </Section>

      <Section id="files" title="Downloads">
        {files.isError ? (
          <p className="text-[15px] text-po-grey">The file list is not reachable right now.</p>
        ) : files.data ? (
          <ul className="divide-y divide-po-line">
            {files.data.map((f) => (
              <li key={f.name} className="py-2">
                <a href={f.url} className="font-medium text-po-accent-ink underline decoration-po-line-strong">
                  {f.name}
                </a>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-po-ink">SHA-256 <Address value={f.sha256} kind="hash" label={`${f.name} SHA-256`} explorer={false} /></p>
              </li>
            ))}
          </ul>
        ) : (
          <Skeleton className="h-[80px] w-full" />
        )}
      </Section>

      <Section id="words" title="Glossary and words we do not use">
        <dl className="divide-y divide-po-line">
          {GLOSSARY.map(([term, def]) => (
            <KeyValue key={term} label={term}>
              {term === 'Reservation' ? reservationDefinition(config.data?.reservation_secs) : def}
            </KeyValue>
          ))}
        </dl>
        <Fold title="Words we do not use, and why">
          <dl className="divide-y divide-po-line">
            {BANNED_WORDS.map(({ word, reason }) => (
              <div key={word} className="grid gap-1 py-2 sm:grid-cols-[220px_1fr] sm:gap-4">
                <dt className="font-medium text-po-ink">&ldquo;{word}&rdquo;</dt>
                <dd>{reason}</dd>
              </div>
            ))}
          </dl>
        </Fold>
      </Section>
    </div>
  )
}
