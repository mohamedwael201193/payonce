// Public verify page — V&A age proof (G8), Concordium testnet only.
//
// What this page shows, live from the API:
//   - the prover's allow-list and the anchored V&A V1 run (VRA/VAA);
//   - a "try a forbidden shape" button: asking the prover to reveal a
//     first name returns the real HTTP 403 REVEAL_REFUSED;
//   - a "verify my age proof" panel: the allowed 18+ shape goes through
//     the prover to the official testnet verifier and shows the real
//     200 (valid) or 400 (valid:false on a rejected presentation).
//
// PRECISION (§1.2 — read before editing this copy): the proven live
// rejection is a TAMPERED presentation (official verifier, HTTP 400) plus
// forbidden shapes (prover policy, HTTP 403). No test with an under-18
// person has ever been run — this page never claims one. Until the prover
// service is unreachable or not configured, the page shows the honest
// "prover not provisioned yet" state instead of pretending to be live.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ageProofApi, type AgeV1Result } from '../lib/api'
import { ApiError } from '../lib/types'
import { useSlowLoad } from '../components/polish'

const TX_BASE = 'https://ccdexplorer.io/testnet/transaction/'
export const AGE_PROOF_VRA = 'e576b2ed2a3539ecc9da872abad15a8ae1dde07c6aa946d3eb9a2b98718a17dc'
export const AGE_PROOF_VAA = '5dc1e9858e8740a703bc5c437d7442dc624c8afc7b1dd2bc1b6f7b6489c05f51'
export const AGE_PROOF_RECORD_SHA256 = 'fab62d06a55399e76699c52cf64799514b2d06b0b9a0062c16d7c29d9b469d3e'

function randomChallenge(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}


function forbiddenRequest(issuerDid: string): unknown {
  return {
    challenge: randomChallenge(),
    subjectClaims: [
      {
        type: 'identity',
        source: ['accountCredential'],
        issuers: [issuerDid],
        statements: [{ type: 'RevealAttribute', attributeTag: 'firstName' }],
      },
    ],
  }
}

export function AgeProofPage() {
  const [searchParams] = useSearchParams()
  const health = useQuery({
    queryKey: ['age-proof-health'],
    queryFn: ageProofApi.health,
    retry: 1,
  })
  const healthSlow = useSlowLoad(health.isLoading)
  // M3 fix-back: the page takes the payable to unlock (+ the payer) and
  // passes both through to the API. Without them the API verifies but
  // files nothing, so the pay-flow gate can never open — that was the
  // dead end. The payable arrives from the gate's own link
  // (/verify-age?payable=<id>) or from the inputs below.
  const [payableId, setPayableId] = useState(() => searchParams.get('payable') ?? '')
  const [forbidden, setForbidden] = useState<{ status: number; rule: string; reason: string } | null>(null)
  const [forbiddenBusy, setForbiddenBusy] = useState(false)
  const [forbiddenError, setForbiddenError] = useState<string | null>(null)
  const [verify, setVerify] = useState<{ ok: boolean; result: AgeV1Result } | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const issuerDid = health.data?.prover.issuer_did ?? null
  const proverDown =
    health.isError && health.error instanceof ApiError && health.error.body.code === 'prover_unavailable'
  // B7: when the prover is down the two demos are not live demos — they
  // are dead buttons under live-looking copy. Each demo section carries
  // its own visible "Demo unavailable" banner (the status card above is
  // not enough: a judge scrolling straight to a demo would never see it).
  // The prover is a separate service (not the API process). When the API
  // cannot reach it, the demos below are unavailable and say so.
  const demoUnavailable = !health.isLoading && !issuerDid
  const demoUnavailableReason = proverDown
    ? 'The prover service is not reachable or not configured for this API, so this demo cannot run. The anchored run above is the proof that already happened.'
    : 'The prover did not answer, so this demo cannot run right now.'

  async function tryForbidden() {
    if (!issuerDid) return
    setForbiddenBusy(true)
    setForbiddenError(null)
    try {
      const { status, decision } = await ageProofApi.policyCheck(forbiddenRequest(issuerDid))
      setForbidden({ status, rule: decision.rule, reason: decision.reason })
    } catch (e) {
      setForbiddenError(e instanceof ApiError ? e.body.message : 'The request failed.')
    } finally {
      setForbiddenBusy(false)
    }
  }

  const parsedPayable = /^\d+$/.test(payableId.trim()) ? Number(payableId.trim()) : NaN
  const payableOk = Number.isInteger(parsedPayable) && parsedPayable >= 1

  async function tryVerify() {
    if (!payableOk) return
    setVerifyBusy(true)
    setVerifyError(null)
    setVerify(null)
    try {
      const { status, body } = await ageProofApi.runV1(parsedPayable)
      if (status === 200 && body.ok) setVerify({ ok: true, result: body })
      else if (status === 400 || status === 403) setVerify({ ok: false, result: body })
      else setVerifyError(body.message ?? body.error ?? `The API answered HTTP ${status}. Nothing was filed.`)
    } catch (e) {
      setVerifyError(e instanceof ApiError ? e.body.message : 'The request failed. Nothing was filed.')
    } finally {
      setVerifyBusy(false)
    }
  }


  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] leading-[1.1] font-medium tracking-[-0.02em] text-po-ink sm:text-[40px]">Prove you are 18+ without revealing your birthday</h1>
        <p className="mt-3 max-w-[640px] text-po-grey">
          An agent can prove its human is 18 or older — and in the EU — without ever seeing the date of
          birth. The proof is a zero-knowledge presentation from the holder&apos;s Concordium credential,
          checked by the official testnet verifier. Nothing about the person is revealed, not even the
          birthday itself.
        </p>

        {/* Prover status — honest about provisioning. */}
        <section aria-label="Prover status" className="mt-8 po-card p-5 sm:p-6">
          {health.isLoading ? (
            <p className="text-po-grey">
              Checking the age-proof prover…{healthSlow ? ' Still checking — the test API is slow right now.' : ''}
            </p>
          ) : proverDown ? (
            <div>
              <h2 className="text-lg font-medium text-po-ink">Prover not provisioned yet</h2>
              <p className="mt-2 text-po-grey">
                The age-proof prover is a separate service, and this API cannot reach it or is not
                configured with it. Until it answers, this page shows the design and the anchored run —
                it does not pretend to verify live. Age-gated payments (1 CCD or 1.00 EUDemo and up)
                stay refused in the meantime.
              </p>
            </div>
          ) : health.isError ? (
            <div>
              <h2 className="text-lg font-medium text-po-ink">Age proof is unavailable right now</h2>
              <p className="mt-2 text-po-grey">
                {health.error instanceof ApiError ? health.error.body.message : 'The API did not answer.'}
              </p>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-medium text-po-ink">Prover live — {health.data?.prover.network}</h2>
              <p className="mt-2 text-po-grey">
                Attributes held (names only): {health.data?.prover.attributes_held.join(', ')}. The prover
                answers only the shapes on the allow-list below and refuses everything else.
              </p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-po-grey">
                {health.data?.prover.allow_list.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-po-grey">Refused, always: {health.data?.prover.refuses.join('; ')}.</p>
            </div>
          )}
          <p className="mt-4 border-t border-po-line pt-4 text-sm text-po-grey" data-testid="prover-honesty">
            How this is deployed: the prover is its own service, separate from the PayOnce API. It holds
            only the dob and nationality openings of one testnet credential, as that service's own
            environment variables. The API process holds no identity data and calls the prover with a
            bearer token. The prover refuses every reveal and every other attribute. It is a stand-in for
            Concordium's coming Agent IDP, not a replacement for it.
          </p>
        </section>

        {/* Anchored run. */}
        <section aria-label="Anchored run" className="mt-6 po-card p-5 sm:p-6">
          <h2 className="text-lg font-medium text-po-ink">Anchored run — the proof that already happened</h2>
          <p className="mt-2 text-po-grey">
            One V&amp;A V1 run is anchored on testnet: the verifier anchored a request (VRA), the prover
            returned the presentation, the verifier anchored the answer (VAA). Statements: dob in range
            18000101–20081125, nationality in the EU 27 set. Holder: account C3.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-po-ink">Request (VRA)</dt>
              <dd className="min-w-0 break-all">
                <a className="text-po-accent-ink underline" href={`${TX_BASE}${AGE_PROOF_VRA}`} target="_blank" rel="noreferrer">
                  {AGE_PROOF_VRA}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-po-ink">Answer (VAA)</dt>
              <dd className="min-w-0 break-all">
                <a className="text-po-accent-ink underline" href={`${TX_BASE}${AGE_PROOF_VAA}`} target="_blank" rel="noreferrer">
                  {AGE_PROOF_VAA}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-po-ink">Record sha256</dt>
              <dd className="min-w-0 break-all font-mono text-xs text-po-grey">{AGE_PROOF_RECORD_SHA256}</dd>
            </div>
          </dl>
        </section>

        {/* Try a forbidden shape. */}
        <section aria-label="Try a forbidden shape" className="mt-6 po-card p-5 sm:p-6">
          <h2 className="text-lg font-medium text-po-ink">Try a forbidden shape</h2>
          <p className="mt-2 text-po-grey">
            Ask the prover to reveal the holder&apos;s first name. The policy refuses reveals outright —
            the live answer is HTTP 403 <code>REVEAL_REFUSED</code>, before any proof is built.
          </p>
          <button
            type="button"
            onClick={tryForbidden}
            disabled={forbiddenBusy || !issuerDid}
            className="mt-4 po-btn po-btn-ink"
          >
            {forbiddenBusy ? 'Asking the prover…' : 'Reveal the first name'}
          </button>
          {/* Fix-back-7 S2: while health is loading the button is disabled
              with no explanation in this section — the intro copy still
              reads live. The loading banner says why, in place. */}
          {health.isLoading ? (
            <p className="mt-3 rounded-[10px] border border-po-line bg-po-paper p-4 text-sm text-po-grey" role="status">
              Checking the age-proof prover… The demo buttons stay disabled until it answers.
            </p>
          ) : demoUnavailable ? (
            <p className="mt-3 rounded-[10px] border border-po-line bg-po-paper p-4 text-sm text-po-grey" role="note">
              Demo unavailable — {demoUnavailableReason}
            </p>
          ) : null}
          {forbiddenError ? <p className="mt-3 text-sm text-po-grey" role="alert">{forbiddenError}</p> : null}
          {forbidden ? (
            <div className="mt-4 rounded-[10px] border border-po-line bg-po-paper p-4" role="status">
              <p className="text-sm text-po-grey">{`HTTP ${forbidden.status} · rule ${forbidden.rule}`}</p>
              <p className="mt-1 text-sm text-po-grey">{forbidden.reason}</p>
            </div>
          ) : null}
        </section>

        {/* The real check for one invoice. */}
        <section aria-label="Run the 18+ check" className="mt-6 po-card p-5 sm:p-6">
          <h2 className="text-lg font-medium text-po-ink">Run the 18+ check for an invoice</h2>
          <p className="mt-2 text-po-grey">
            This is the extra identity check an age-restricted invoice needs before the agent may pay it. The paying
            account proves 18+ and EU nationality from its Concordium identity, without revealing a birth date. The
            request and the result are anchored on chain (two small testnet transactions), and the proof is filed for
            that invoice for 10 minutes.
          </p>
          <label className="mt-4 block max-w-xs">
            <span className="text-sm font-medium text-po-ink">Invoice number</span>
            <input
              type="text"
              inputMode="numeric"
              value={payableId}
              onChange={(e) => setPayableId(e.target.value)}
              placeholder="e.g. 1007"
              aria-label="Invoice number"
              aria-invalid={payableId.trim() !== '' && !payableOk}
              className="po-input mt-1"
            />
          </label>
          {payableId.trim() !== '' && !payableOk ? (
            <p className="mt-2 text-sm text-po-bad" role="alert">Enter an invoice number, for example 1007.</p>
          ) : null}
          <button
            type="button"
            onClick={tryVerify}
            disabled={verifyBusy || !issuerDid || !payableOk}
            className="mt-4 po-btn po-btn-ink"
          >
            {verifyBusy ? 'Checking… (about 30 seconds)' : 'Run the 18+ check'}
          </button>
          {!payableOk && payableId.trim() === '' ? (
            <p className="mt-2 text-sm text-po-grey">Enter the invoice number first.</p>
          ) : null}
          {health.isLoading ? (
            <p className="mt-3 rounded-[10px] border border-po-line bg-po-paper p-4 text-sm text-po-grey" role="status">
              Checking the age-proof prover… The demo buttons stay disabled until it answers.
            </p>
          ) : demoUnavailable ? (
            <p className="mt-3 rounded-[10px] border border-po-line bg-po-paper p-4 text-sm text-po-grey" role="note">
              Demo unavailable — {demoUnavailableReason}
            </p>
          ) : null}
          {verifyError ? <p className="mt-3 text-sm text-po-grey" role="alert">{verifyError}</p> : null}
          {verify?.ok ? (
            <div className="mt-4 rounded-[10px] border border-po-line bg-po-paper p-4" role="status">
              <p className="font-medium text-po-ink">Match: 18+ proven for invoice {verify.result.payable_id}</p>
              <p className="mt-1 text-sm text-po-grey">
                {(verify.result.statements ?? []).join(', ') || '18+ and EU nationality'}. Filed for the paying account for{' '}
                {Math.round((verify.result.valid_for_seconds ?? 600) / 60)} minutes: pay the invoice within that time.
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {verify.result.vra_tx ? <li><a className="text-po-accent-ink underline" href={`${TX_BASE}${verify.result.vra_tx}`} target="_blank" rel="noreferrer">Request anchored on CCDExplorer</a></li> : null}
                {verify.result.vaa_tx ? <li><a className="text-po-accent-ink underline" href={`${TX_BASE}${verify.result.vaa_tx}`} target="_blank" rel="noreferrer">Result anchored on CCDExplorer</a></li> : null}
              </ul>
            </div>
          ) : verify ? (
            <div className="mt-4 rounded-[10px] border border-po-line bg-po-paper p-4" role="status">
              <p className="font-medium text-po-ink">No match: nothing was filed</p>
              <p className="mt-1 text-sm text-po-grey">
                {verify.result.error ?? verify.result.message ?? 'The check did not pass.'}
                {verify.result.step ? ` (step: ${verify.result.step})` : ''}
              </p>
            </div>
          ) : null}
        </section>

        {/* Precision note. */}
        <section aria-label="What this proves" className="mt-6 po-card p-5 sm:p-6">
          <h2 className="text-lg font-medium text-po-ink">What this proves — and what it does not</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-po-grey">
            <li>
              Proven live: forbidden statement shapes are refused with HTTP 403 by the prover policy
              (18 shapes), and a tampered presentation is rejected with HTTP 400 by the official
              testnet verifier.
            </li>
            <li>
              Not proven, and not claimed here: a refusal of an under-18 person. No under-18 identity
              exists in the lab, so no such test has ever been run. A real under-18 refusal would need
              a second lab identity with a date of birth under 18 years ago.
            </li>
            <li>
              Payments of 1 CCD or 1.00 EUDemo and up need a fresh (within 10 minutes) verified 18+
              proof for the payer on file for that payable; below that, age proof is optional.
            </li>
          </ul>
          <p className="mt-4 text-sm">
            <Link to="/app" className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline">
              Pay an invoice
            </Link>
          </p>
        </section>
      </div>
    </div>
  )
}
