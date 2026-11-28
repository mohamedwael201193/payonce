// Verification of Payee, payee side: the wallet reveals the name behind this account (a person's first and last
// name, or a company's legal name), PayOnce verifies the proof and files it for the account. Then anyone can check an
// invoice's payee name against it: Match / Close match / No match / Unverified payee.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, ButtonRow, Card, Notice, StatusPill } from '../app/ui'
import { useWallet } from './WalletContext'
import { walletApi, WalletApiError } from './api'
import { walletErrorText } from './types'
import { TxLine } from './WalletUI'

interface Proof { account: string; kind: 'person' | 'business'; name: string; version: 'v1' | 'v0'; vra_tx: string | null; vaa_tx: string | null; verified_at: string; issuer: string | null }
interface Check { id: string; label: string; status: string; detail: string }
type Verdict = 'match' | 'close_match' | 'no_match' | 'unverified'
const VERDICT: Record<Verdict, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  match: { tone: 'ok', text: 'Match' },
  close_match: { tone: 'warn', text: 'Close match' },
  no_match: { tone: 'bad', text: 'No match' },
  unverified: { tone: 'neutral', text: 'Unverified payee' },
}

export function usePayeeProof(account: string) {
  return useQuery({ queryKey: ['payee-proof', account], queryFn: () => walletApi<{ proof: Proof | null }>(`/api/wallet/payee-proof/${account}`) })
}

export function MatchChecker({ account, initial = '' }: { account: string; initial?: string }) {
  const [name, setName] = useState(initial)
  const [res, setRes] = useState<{ verdict: Verdict; proven_name: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true)
    try { setRes(await walletApi(`/api/wallet/payee-proof/${account}/match?name=${encodeURIComponent(name)}`)) } catch { setRes(null) } finally { setBusy(false) }
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void check() }}>
      <label className="flex flex-col gap-1 text-sm text-po-ink">Try it: the payee name an invoice shows
        <input className="po-input min-h-[44px] rounded-[10px] border border-po-line px-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name on the invoice" />
      </label>
      <ButtonRow>
        <Button small type="submit" busy={busy} disabled={!name.trim()}>Check the name</Button>
        {res ? <StatusPill tone={VERDICT[res.verdict].tone}>{VERDICT[res.verdict].text}</StatusPill> : null}
      </ButtonRow>
      {res?.verdict === 'close_match' && res.proven_name ? <p className="text-sm text-po-grey">The verified name is “{res.proven_name}”. A payer should confirm before paying.</p> : null}
    </form>
  )
}

export function PayeeProof({ account }: { account: string }) {
  const w = useWallet()
  const qc = useQueryClient()
  const q = usePayeeProof(account)
  const [kind, setKind] = useState<'person' | 'business'>('person')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const proof = q.data?.proof ?? null

  async function prove() {
    if (!w.session) return
    setErr(null); setChecks(null)
    try {
      setBusy(w.session.kind === 'browser' ? 'Anchoring the proof request on chain (about 10 seconds)…' : 'Preparing the proof request…')
      const req = await walletApi<{ request_id: string; v1?: unknown; v0: { challenge: string; statements: unknown } }>('/api/wallet/payee-proof/request', { method: 'POST', body: { account, kind, wallet: w.session.kind } })
      setBusy('Approve the proof in your wallet. It reveals only the name, nothing else…')
      const out = await w.session.requestProof({ v1: req.v1, v0: req.v0 })
      setBusy('Verifying the proof…')
      const v = await walletApi<{ verified: boolean; checks: Check[] }>('/api/wallet/payee-proof/verify', { method: 'POST', body: { request_id: req.request_id, version: out.version, presentation: out.presentation } })
      setChecks(v.checks)
      if (!v.verified) setErr('The proof did not verify. See the checks below.')
      await qc.invalidateQueries({ queryKey: ['payee-proof', account] })
    } catch (e) {
      setErr(e instanceof WalletApiError ? e.message : walletErrorText(e))
    } finally { setBusy(null) }
  }

  if (proof) {
    return (
      <Card className="flex flex-col gap-3" data-testid="payee-proof-done">
        <p className="text-po-ink">Verified payee name: <strong>{proof.name}</strong> <StatusPill tone="ok">{proof.kind === 'business' ? 'Company legal name' : 'Legal name'}</StatusPill></p>
        <p className="text-sm text-po-grey">Proven from your own wallet ({proof.version === 'v1' ? 'Verify & Access V1, anchored on chain' : 'Web3 ID proof, checked by Concordium’s testnet verifier'}), bound to this account. Payers and their agents now get <strong>Match</strong> when an invoice names you correctly, and a warning when it does not.</p>
        {proof.vra_tx ? <TxLine label="Request anchor (VRA)" hash={proof.vra_tx} /> : null}
        {proof.vaa_tx ? <TxLine label="Audit anchor (VAA)" hash={proof.vaa_tx} /> : null}
        <MatchChecker account={account} initial={proof.name} />
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-po-grey">Payers and their AI agents check that the name on an invoice belongs to the account being paid, like bank “Verification of Payee”. Prove your name once from your wallet; it reveals only the name.</p>
      <fieldset className="flex flex-wrap gap-4 text-po-ink">
        <legend className="sr-only">Who gets paid</legend>
        <label className="inline-flex min-h-[44px] items-center gap-2"><input type="radio" name="kind" checked={kind === 'person'} onChange={() => setKind('person')} />Me (first and last name)</label>
        <label className="inline-flex min-h-[44px] items-center gap-2"><input type="radio" name="kind" checked={kind === 'business'} onChange={() => setKind('business')} />My company (legal name, needs a company identity)</label>
      </fieldset>
      <Button id="prove-name" variant="primary" size="lg" busy={Boolean(busy)} onClick={() => void prove()}>Prove my name from my wallet</Button>
      {busy ? <Notice>{busy}</Notice> : null}
      {checks ? <ul className="flex flex-col gap-1 text-sm">{checks.map((c) => <li key={c.id} className={c.status === 'ok' ? 'text-po-ok' : 'text-po-bad'}>{c.status === 'ok' ? '✓' : '✗'} {c.label} <span className="text-po-grey">({c.detail})</span></li>)}</ul> : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      <p className="text-sm text-po-grey">Optional for this demo: you can skip to the next step. Without it, payers see “Unverified payee”.</p>
    </div>
  )
}
