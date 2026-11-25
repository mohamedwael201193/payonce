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
// sidecar is provisioned on the API host, the page shows the honest
// "prover not provisioned yet" state instead of pretending to be live.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ageProofApi } from '../lib/api'
import { ApiError } from '../lib/types'
import { AppHeader } from '../components/AppHeader'
import { Footer } from '../components/Sections'
import { useSlowLoad } from '../components/polish'

const TX_BASE = 'https://ccdexplorer.io/testnet/transaction/'
const EU27 = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']
export const AGE_PROOF_VRA = 'e576b2ed2a3539ecc9da872abad15a8ae1dde07c6aa946d3eb9a2b98718a17dc'
export const AGE_PROOF_VAA = '5dc1e9858e8740a703bc5c437d7442dc624c8afc7b1dd2bc1b6f7b6489c05f51'
export const AGE_PROOF_RECORD_SHA256 = 'fab62d06a55399e76699c52cf64799514b2d06b0b9a0062c16d7c29d9b469d3e'

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// The prover accepts a dob upper bound of today minus 18 or 21 years,
// with a +0 or +1 day offset (the SDK's addMinimumAge uses +1 day).
function upperMinusYears(years: number): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  d.setDate(d.getDate() + 1)
  return yyyymmdd(d)
}

function randomChallenge(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function allowedRequest(issuerDid: string): unknown {
  return {
    challenge: randomChallenge(),
    subjectClaims: [
      {
        type: 'identity',
        source: ['accountCredential'],
        issuers: [issuerDid],
        statements: [
          { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: upperMinusYears(18) },
          { type: 'AttributeInSet', attributeTag: 'nationality', set: EU27 },
        ],
      },
    ],
  }
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
  const [payer, setPayer] = useState('')
  const [forbidden, setForbidden] = useState<{ status: number; rule: string; reason: string } | null>(null)
  const [forbiddenBusy, setForbiddenBusy] = useState(false)
  const [forbiddenError, setForbiddenError] = useState<string | null>(null)
  const [verify, setVerify] = useState<{ status: number; valid: boolean; detail: string } | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  // Fix-back-2 MF2: the filing outcome is the API's own `binding` /
  // `holder`, not a generic guess. The pay gate (api/src/server.mjs)
  // honours ONLY proofs filed for its fixed PAYER_ADDRESS, so "the age
  // gate is open for this payer" was false for any other payer — the
  // page now says "filed for this payer" and names the binding reason.
  function filingDetail(result: {
    filed_for_payable?: number | null
    holder?: string | null
    binding?: string
  }): string {
    if (result.filed_for_payable) {
      return `Filed for payable ${result.filed_for_payable} for this payer${
        result.holder ? ` (holder ${result.holder})` : ''
      }. The pay gate opens only for a proof filed for the payer the pay flow uses — pay within 10 minutes.`
    }
    switch (result.binding) {
      case 'not_requested':
        return 'Nothing was filed: no payable + payer were given, so this was verify-only (binding: not_requested).'
      case 'no_dob_proof':
        return 'Nothing was filed: the proof did not prove 18+ (binding: no_dob_proof).'
      case 'holder_missing':
        return 'Nothing was filed: the presentation named no holder that resolves to a payer (binding: holder_missing).'
      case 'holder_unresolved':
        return 'Nothing was filed: the presentation holder could not be resolved on chain (binding: holder_unresolved).'
      case 'holder_mismatch':
        return `Nothing was filed: the proof belongs to holder ${result.holder ?? 'unknown'}, not the payer entered (binding: holder_mismatch) — a proof filed for another payer never opens the gate.`
      default:
        return `Nothing was filed${result.binding ? ` (binding: ${result.binding})` : ''}.`
    }
  }

  const issuerDid = health.data?.prover.issuer_did ?? null
  const proverDown =
    health.isError && health.error instanceof ApiError && health.error.body.code === 'prover_unavailable'
  // B7: when the prover is down the two demos are not live demos — they
  // are dead buttons under live-looking copy. Each demo section carries
  // its own visible "Demo unavailable" banner (the status card above is
  // not enough: a judge scrolling straight to a demo would never see it).
  // The sidecar file (prover-C3.private.json) is provisioned only on the
  // OLD API host, and the material is not in this workspace — so this page
  // fix, not a provisioning, is what this commit can do. No deploy, no
  // invented secret.
  const demoUnavailable = !health.isLoading && !issuerDid
  const demoUnavailableReason = proverDown
    ? 'The prover is not provisioned on this API host yet, so this demo cannot run. The anchored run above is the proof that already happened.'
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

  async function tryVerify() {
    if (!issuerDid) return
    setVerifyBusy(true)
    setVerifyError(null)
    try {
      const parsedPayable = Number.parseInt(payableId, 10)
      const { status, result } = await ageProofApi.verify(
        allowedRequest(issuerDid),
        Number.isInteger(parsedPayable) && parsedPayable >= 1 ? parsedPayable : undefined,
        payer.trim() ? payer.trim() : undefined,
      )
      setVerify({
        status,
        valid: result.valid,
        detail: result.valid
          ? `Valid 18+ proof — ${result.statements?.join(', ') ?? 'dob>=18, nationality in EU27'}. ${filingDetail(result)}`
          : `Rejected by the official testnet verifier (HTTP ${result.verifier_status ?? status}).`,
      })
    } catch (e) {
      setVerifyError(e instanceof ApiError ? e.body.message : 'The request failed.')
    } finally {
      setVerifyBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-paper pb-24 md:pb-0">
      {/* B7: the header is white-on-dark by design — on the light paper
          background its nav text was near-invisible. Same dark band as the
          judges/receipt pages. */}
      <div className="bg-sky-0">
        <AppHeader dark />
      </div>
      <main className="mx-auto max-w-[880px] px-4 py-10 sm:px-6">
        <p className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">Age proof · V&amp;A · Testnet</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">Prove you are 18+ without revealing your birthday</h1>
        <p className="mt-3 max-w-[640px] text-body">
          An agent can prove its human is 18 or older — and in the EU — without ever seeing the date of
          birth. The proof is a zero-knowledge presentation from the holder&apos;s Concordium credential,
          checked by the official testnet verifier. Nothing about the person is revealed, not even the
          birthday itself.
        </p>

        {/* Prover status — honest about provisioning. */}
        <section aria-label="Prover status" className="mt-8 rounded-[20px] border border-line bg-card p-6">
          {health.isLoading ? (
            <p className="text-body">
              Checking the age-proof prover…{healthSlow ? ' Still checking — the test API is slow right now.' : ''}
            </p>
          ) : proverDown ? (
            <div>
              <h2 className="text-lg font-semibold text-ink">Prover not provisioned yet</h2>
              <p className="mt-2 text-body">
                The age-proof prover runs as a loopback sidecar on the API host, and its secret sidecar
                file has not been provisioned there yet. Until it is, this page shows the design and the
                anchored run — it does not pretend to verify live. Age-gated payments (1 CCD or 1.00
                EUDemo and up) stay refused in the meantime.
              </p>
            </div>
          ) : health.isError ? (
            <div>
              <h2 className="text-lg font-semibold text-ink">Age proof is unavailable right now</h2>
              <p className="mt-2 text-body">
                {health.error instanceof ApiError ? health.error.body.message : 'The API did not answer.'}
              </p>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-semibold text-ink">Prover live — {health.data?.prover.network}</h2>
              <p className="mt-2 text-body">
                Attributes held (names only): {health.data?.prover.attributes_held.join(', ')}. The prover
                answers only the shapes on the allow-list below and refuses everything else.
              </p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-body">
                {health.data?.prover.allow_list.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-muted">Refused, always: {health.data?.prover.refuses.join('; ')}.</p>
            </div>
          )}
        </section>

        {/* Anchored run. */}
        <section aria-label="Anchored run" className="mt-6 rounded-[20px] border border-line bg-card p-6">
          <h2 className="text-lg font-semibold text-ink">Anchored run — the proof that already happened</h2>
          <p className="mt-2 text-body">
            One V&amp;A V1 run is anchored on testnet: the verifier anchored a request (VRA), the prover
            returned the presentation, the verifier anchored the answer (VAA). Statements: dob in range
            18000101–20081125, nationality in the EU 27 set. Holder: account C3.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-ink">Request (VRA)</dt>
              <dd className="min-w-0 break-all">
                <a className="text-brand-700 underline" href={`${TX_BASE}${AGE_PROOF_VRA}`} target="_blank" rel="noreferrer">
                  {AGE_PROOF_VRA}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-ink">Answer (VAA)</dt>
              <dd className="min-w-0 break-all">
                <a className="text-brand-700 underline" href={`${TX_BASE}${AGE_PROOF_VAA}`} target="_blank" rel="noreferrer">
                  {AGE_PROOF_VAA}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-32 shrink-0 font-medium text-ink">Record sha256</dt>
              <dd className="min-w-0 break-all font-mono text-xs text-body">{AGE_PROOF_RECORD_SHA256}</dd>
            </div>
          </dl>
        </section>

        {/* Try a forbidden shape. */}
        <section aria-label="Try a forbidden shape" className="mt-6 rounded-[20px] border border-line bg-card p-6">
          <h2 className="text-lg font-semibold text-ink">Try a forbidden shape</h2>
          <p className="mt-2 text-body">
            Ask the prover to reveal the holder&apos;s first name. The policy refuses reveals outright —
            the live answer is HTTP 403 <code>REVEAL_REFUSED</code>, before any proof is built.
          </p>
          <button
            type="button"
            onClick={tryForbidden}
            disabled={forbiddenBusy || !issuerDid}
            className="mt-4 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {forbiddenBusy ? 'Asking the prover…' : 'Reveal the first name'}
          </button>
          {/* Fix-back-7 S2: while health is loading the button is disabled
              with no explanation in this section — the intro copy still
              reads live. The loading banner says why, in place. */}
          {health.isLoading ? (
            <p className="mt-3 rounded-[12px] border border-line bg-paper p-4 text-sm text-body" role="status">
              Checking the age-proof prover… The demo buttons stay disabled until it answers.
            </p>
          ) : demoUnavailable ? (
            <p className="mt-3 rounded-[12px] border border-line bg-paper p-4 text-sm text-body" role="note">
              Demo unavailable — {demoUnavailableReason}
            </p>
          ) : null}
          {forbiddenError ? <p className="mt-3 text-sm text-body" role="alert">{forbiddenError}</p> : null}
          {forbidden ? (
            <div className="mt-4 rounded-[12px] border border-line bg-paper p-4" role="status">
              <p className="text-sm text-body">{`HTTP ${forbidden.status} · rule ${forbidden.rule}`}</p>
              <p className="mt-1 text-sm text-body">{forbidden.reason}</p>
            </div>
          ) : null}
        </section>

        {/* Verify panel. */}
        <section aria-label="Verify my age proof" className="mt-6 rounded-[20px] border border-line bg-card p-6">
          <h2 className="text-lg font-semibold text-ink">Verify my age proof</h2>
          <p className="mt-2 text-body">
            Send the allowed shape — dob in the 18+ range plus EU nationality — through the prover to the
            official testnet verifier. A valid presentation returns HTTP 200; a rejected one returns HTTP
            400. Give the payable and the payer too, and a valid proof is
            filed for that payer and payable — that is what the pay gate honours for a gated pay (1 CCD or
            1.00 EUDemo and up) for 10 minutes, when the filed payer is the payer the pay flow uses.
            Without them the proof verifies but files nothing.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-ink">Payable to unlock</span>
              <input
                type="text"
                inputMode="numeric"
                value={payableId}
                onChange={(e) => setPayableId(e.target.value)}
                placeholder="e.g. 1007"
                aria-label="Payable to unlock"
                className="mt-1 w-full rounded-[12px] border border-line bg-paper px-3 py-2 text-sm text-ink"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-ink">Payer account</span>
              <input
                type="text"
                value={payer}
                onChange={(e) => setPayer(e.target.value)}
                placeholder="e.g. 4MvdME… (demo payer)"
                aria-label="Payer account"
                className="mt-1 w-full rounded-[12px] border border-line bg-paper px-3 py-2 text-sm text-ink"
              />
            </label>
          </div>
          <p className="mt-2 text-sm text-muted">
            The proof is filed only when the presentation&apos;s credential holder is this payer — a proof
            for someone else never unlocks your pay.
          </p>
          <button
            type="button"
            onClick={tryVerify}
            disabled={verifyBusy || !issuerDid}
            className="mt-4 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {verifyBusy ? 'Verifying…' : 'Verify the 18+ proof'}
          </button>
          {health.isLoading ? (
            <p className="mt-3 rounded-[12px] border border-line bg-paper p-4 text-sm text-body" role="status">
              Checking the age-proof prover… The demo buttons stay disabled until it answers.
            </p>
          ) : demoUnavailable ? (
            <p className="mt-3 rounded-[12px] border border-line bg-paper p-4 text-sm text-body" role="note">
              Demo unavailable — {demoUnavailableReason}
            </p>
          ) : null}
          {verifyError ? <p className="mt-3 text-sm text-body" role="alert">{verifyError}</p> : null}
          {verify ? (
            <div className="mt-4 rounded-[12px] border border-line bg-paper p-4" role="status">
              <p className="text-sm text-body">{`HTTP ${verify.status} · valid: ${verify.valid ? 'true' : 'false'}`}</p>
              <p className="mt-1 text-sm text-body">{verify.detail}</p>
            </div>
          ) : null}
        </section>

        {/* Precision note. */}
        <section aria-label="What this proves" className="mt-6 rounded-[20px] border border-line bg-card p-6">
          <h2 className="text-lg font-semibold text-ink">What this proves — and what it does not</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-body">
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
            <Link to="/" className="font-medium text-brand-700">
              Back to PayOnce
            </Link>
          </p>
        </section>
      </main>
      <Footer />
    </div>
  )
}
