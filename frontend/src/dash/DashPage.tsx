// /app dashboard (behind the flag, see flag.ts): one linear flow, Get paid -> Pay.
// R0 Connect · R1 Prove your name · R2 Become a payee · R3 Get paid · R4 Now you pay · R5 Your record.
// Real today: wallet connect, the name proof, check_payee, the relay prepare call, tx status.
// Every PLANNED call (contracts.ts) shows "not live yet" when the API answers 404; nothing is faked.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WalletProvider, useWallet } from '../wallet/WalletContext'
import { walletApi, waitForTx, WalletApiError } from '../wallet/api'
import { WalletTooOld, walletErrorText } from '../wallet/types'
import { useAccountInfo } from '../wallet/WalletUI'
import { RunConnect } from '../app/run/RunWallet'
import { FAKE_PAYEE } from '../app/run/flow'
import { AGENTS } from '../app/identity'
import { midTruncate } from '../app/Address'
import { useDocumentTitle } from '../app/hooks'
import { NotShipped, dashApi, type CheckPayee, type GetPaidJob, type RedirectResult, type RecordItem } from './contracts'
import { HumanGate } from './gates'
import { Services } from './Services'
import { lookalike } from './lookalike'
import { acceptPayeeParamHex } from './params'
import { ChainBar, CheckTicks, HoldRing, PayeeDiff, Stamp, useTxStatus } from './motion'
import '../app/run/run.css'
import './dash.css'

export const DEMO_SELLER = AGENTS[0].owner
const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/'
const short = (a: string) => midTruncate(a, 6, 6)
const CCD_MICRO = '1000000'
const EUDEMO_MICRO = '10000'
type PayRail = 'ccd' | 'eudemo'
const amountMicro = (rail: PayRail) => (rail === 'eudemo' ? EUDEMO_MICRO : CCD_MICRO)
const amountLabel = (rail: PayRail) => (rail === 'eudemo' ? '0.01 EUDemo' : '1 CCD')
/** First completed EUDemo VoP run, 28 Nov 2026. Re-reserve was refused -16. */
const EUDEMO_REPLAY_TX = '5fac785d9174277ef182a427242c3fb6fc8fadfaa0e8d68799f075d48c012fbd'
const EUDEMO_EVIDENCE = '/evidence/eudemo-vop-run-2026-11-28.json'

function rejectOf(e: unknown): { code: number; name?: string } | null {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /reject(?: code)?\s+(-?\d+)/i.exec(msg)
  return m ? { code: Number(m[1]) } : null
}
type OutLegs = { reserve?: string; transfer?: string; confirm?: string; replay?: string; replayCode?: number | null; replayName?: string; replayMsg?: string }

export const STEPS = [
  { key: 'connect', label: 'Connect', group: 'get' },
  { key: 'prove', label: 'Prove your name', group: 'get' },
  { key: 'payee', label: 'Become a payee', group: 'get' },
  { key: 'paid', label: 'Get paid', group: 'get' },
  { key: 'pay', label: 'Now you pay', group: 'pay' },
  { key: 'record', label: 'Your record', group: 'pay' },
] as const

type Async<T> = { s: 'idle' } | { s: 'busy'; note: string } | { s: 'done'; v: T } | { s: 'error'; msg: string } | { s: 'pending'; route: string }

function errOf(e: unknown): Async<never> {
  if (e instanceof NotShipped) return { s: 'pending', route: e.route }
  if (e instanceof WalletTooOld) return { s: 'error', msg: e.message }
  if (e instanceof WalletApiError) return { s: 'error', msg: e.message }
  return { s: 'error', msg: walletErrorText(e) }
}

export function Pending({ route }: { route: string }) {
  return <p className="ds-pending" data-testid="not-live"><span aria-hidden>◌</span> Not live yet <code>{route}</code></p>
}

function State<T>({ a, children }: { a: Async<T>; children?: (v: T) => React.ReactNode }) {
  if (a.s === 'busy') return <p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />{a.note}</p>
  if (a.s === 'error') return <p className="ds-err" role="alert">{a.msg}</p>
  if (a.s === 'pending') return <Pending route={a.route} />
  if (a.s === 'done' && children) return <>{children(a.v)}</>
  return null
}

function Tx({ hash, label }: { hash: string; label: string }) {
  return <a className="ds-tx" href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">{label} <code>{short(hash)}</code> ↗</a>
}

function checksOf(c: CheckPayee) {
  const plain: Record<string, string> = {
    account_exists: 'Account exists',
    account_identity: 'Backed by an identity',
    name_proof: 'Name proven by the payee',
    name_match: 'Name matches the invoice',
    payee_book_bound: 'Bound by the payee’s signature',
    cooling_off_over: 'Hold finished',
  }
  return c.checks.map((x) => ({ ok: x.ok, text: plain[x.id] ?? x.detail }))
}

export function stampFor(check: CheckPayee): { verdict: CheckPayee['verdict']; word?: string; tone?: 'ok' | 'warn' | 'bad'; sub?: string; shown: string } {
  if (check.verdict === 'MATCH' && !check.payable) {
    return { verdict: check.verdict, word: 'Not bound', tone: 'warn', sub: check.verified_name ?? 'Name matches, but this account is not a payee yet', shown: 'NOT_BOUND' }
  }
  return { verdict: check.verdict, sub: check.verified_name ?? undefined, shown: check.verdict }
}

/** One sentence under the stamp. The API's "Match: the account belongs to…" is about the name only; it must not sit
    under a "Not bound" stamp. */
export function reasonFor(check: CheckPayee): string | null {
  if (check.verdict === 'MATCH' && !check.payable) {
    return 'The name matches, but this account is not a payee yet. It must sign the payee book and finish the hold before PayOnce will pay it.'
  }
  return check.reasons[0] ?? null
}

export function VerdictBlock({ check }: { check: CheckPayee }) {
  const st = stampFor(check)
  return (
    <div className="ds-verdict" data-testid="verdict" data-verdict={st.shown}>
      <Stamp verdict={st.verdict} word={st.word} tone={st.tone} sub={st.sub} />
      <CheckTicks items={checksOf(check)} />
    </div>
  )
}

function Rail({ step, done, go, canGo }: { step: number; done: boolean[]; go: (n: number) => void; canGo: (n: number) => boolean }) {
  const still = useReducedMotion()
  return (
    <ol className="ds-rail" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.key} className={`${i === step ? 'is-now' : ''} ${done[i] ? 'is-done' : ''} ${i === 4 ? 'is-split' : ''}`}>
          <button onClick={() => canGo(i) && go(i)} disabled={!canGo(i)} aria-current={i === step ? 'step' : undefined}>
            <span className="ds-rail__dot">{done[i] ? '✓' : i}</span>
            <span className="ds-rail__label">{s.label}</span>
          </button>
          {i === step && !still ? <motion.span layoutId="ds-rail-glow" className="ds-rail__glow" /> : null}
        </li>
      ))}
    </ol>
  )
}

function Card({ k, title, children }: { k: string; title: string; children: React.ReactNode }) {
  const still = useReducedMotion()
  return (
    <motion.section key={k} className="ds-card" initial={still ? false : { opacity: 0, y: 16, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={still ? undefined : { opacity: 0, y: -10 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
      <h2 className="ds-h2">{title}</h2>
      {children}
    </motion.section>
  )
}

function Flow() {
  useDocumentTitle('Your dashboard')
  const w = useWallet()
  const qc = useQueryClient()
  const acct = w.session?.account ?? null
  const bal = useAccountInfo(acct)
  const proofQ = useQuery({ queryKey: ['payee-proof', acct], enabled: !!acct, queryFn: () => dashApi.payeeProof(acct!) })
  const proof = proofQ.data?.proof ?? null
  const [params] = useSearchParams()
  const payParam = params.get('pay') ?? params.get('payee')
  const [step, setStep] = useState(payParam ? 4 : 0)
  const [kind, setKind] = useState<'person' | 'business'>('person')
  const [prove, setProve] = useState<Async<true>>({ s: 'idle' })
  const [bind, setBind] = useState<Async<string>>({ s: 'idle' })
  const [bindTx, setBindTx] = useState<string | null>(null)
  const [bindAt, setBindAt] = useState(0)
  const bindSt = useTxStatus(bindTx)
  const [bound, setBound] = useState(false)
  const [invoice, setInvoice] = useState('')
  const [job, setJob] = useState<Async<GetPaidJob>>({ s: 'idle' })
  const [redir, setRedir] = useState<Async<RedirectResult>>({ s: 'idle' })
  const [payTo, setPayTo] = useState(payParam ?? '')
  const [payName, setPayName] = useState('')
  const [outCheck, setOutCheck] = useState<Async<CheckPayee>>({ s: 'idle' })
  const [outTx, setOutTx] = useState<string | null>(null)
  const [outAt, setOutAt] = useState(0)
  const outSt = useTxStatus(outTx)
  const [outPay, setOutPay] = useState<Async<true>>({ s: 'idle' })
  const [payRail, setPayRail] = useState<PayRail>('ccd')
  const [outLegs, setOutLegs] = useState<OutLegs>({})
  const [declined, setDeclined] = useState(false)
  const [record, setRecord] = useState<Async<RecordItem[]>>({ s: 'idle' })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // Facts move the flow forward on their own.
  useEffect(() => { if (acct && step === 0) setStep(proof ? 2 : 1) }, [acct]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (bindSt.phase === 'finalized') setBound(true) }, [bindSt.phase])
  useEffect(() => {
    if (!acct) return
    dashApi.payeeStatus(acct).then((p) => alive.current && p.status === 'Bound' && setBound(true)).catch(() => {})
  }, [acct])
  useEffect(() => {
    if (proof && !invoice) setInvoice(`Invoice to: PayOnce reference payer\nFrom: ${proof.name}\nPay to: ${proof.account}\nAmount: 1 CCD`)
  }, [proof]) // eslint-disable-line react-hooks/exhaustive-deps

  const done = [!!acct, !!proof, bound, job.s === 'done' && job.v.stage === 'paid', outSt.phase === 'finalized', record.s === 'done' && record.v.length > 0]

  const proveGen = useRef(0)
  async function proveName() {
    if (!w.session || !acct) return
    const my = ++proveGen.current
    try {
      setProve({ s: 'busy', note: w.session.kind === 'browser' ? 'Anchoring the request on chain… If the wallet already shows Approve, wait until this line changes before tapping it.' : 'Preparing the request…' })
      const req = await walletApi<{ request_id: string; v1?: unknown; v0: { challenge: string; statements: unknown } }>('/api/wallet/payee-proof/request', { method: 'POST', body: { account: acct, kind, wallet: w.session.kind } })
      if (my !== proveGen.current) return
      setProve({ s: 'busy', note: 'Approve in the Concordium Wallet window or tab. Only the name is shared. If nothing happens, look for a wallet tab in the browser.' })
      const out = await Promise.race([
        w.session.requestProof({ v1: req.v1, v0: req.v0 }),
        new Promise<never>((_, rej) => {
          window.setTimeout(() => rej(new Error('The wallet did not answer in 90 seconds. Close the wallet tab and try again.')), 90_000)
        }),
      ])
      if (my !== proveGen.current) return
      setProve({ s: 'busy', note: 'Checking the proof…' })
      const v = await walletApi<{ verified: boolean }>('/api/wallet/payee-proof/verify', { method: 'POST', body: { request_id: req.request_id, version: out.version, presentation: out.presentation } })
      if (my !== proveGen.current) return
      if (!v.verified) return setProve({ s: 'error', msg: 'The proof did not verify.' })
      await qc.invalidateQueries({ queryKey: ['payee-proof', acct] })
      setProve({ s: 'done', v: true })
      setStep(2)
    } catch (e) {
      if (my !== proveGen.current) return
      setProve(errOf(e))
    }
  }
  function cancelProve() {
    proveGen.current += 1
    setProve({ s: 'idle' })
  }

  async function becomePayee() {
    if (!w.session || !acct) return
    try {
      if (!w.session.sendSponsored) throw new WalletTooOld()
      setBind({ s: 'busy', note: 'Asking the demo book to propose you…' })
      const p = await dashApi.propose(acct)
      if (p.status === 'Bound') { setBind({ s: 'done', v: p.tx_hash ?? 'already-bound' }); return }
      setBind({ s: 'busy', note: 'Preparing a sponsored transaction…' })
      const prep = await dashApi.prepare(acct, 'accept_payee', acceptPayeeParamHex(p.seller, p.version, p.proof_anchor))
      setBind({ s: 'busy', note: 'Sign in your wallet. PayOnce pays the fee.' })
      setBindAt(Date.now())
      const hash = await w.session.sendSponsored(prep.transaction, prep.schema)
      setBindTx(hash)
      setBind({ s: 'done', v: hash })
    } catch (e) { setBind(errOf(e)) }
  }

  async function getPaid() {
    if (!acct) return
    try {
      setJob({ s: 'busy', note: 'Reading your invoice…' })
      const parsed = await dashApi.parseInvoice(invoice).catch((e) => { if (e instanceof NotShipped) return null; throw e })
      const { job_id } = await dashApi.startGetPaid(acct, parsed)
      for (let i = 0; i < 120 && alive.current; i++) {
        const j = await dashApi.getPaidJob(job_id)
        if (!alive.current) return
        setJob({ s: 'done', v: j })
        if (j.stage === 'paid' || j.stage === 'refused' || j.stage === 'failed') { await qc.invalidateQueries({ queryKey: ['wallet-account', acct] }); return }
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch (e) { setJob(errOf(e)) }
  }

  async function tryRedirect() {
    if (job.s !== 'done') return
    try {
      setRedir({ s: 'busy', note: 'Telling the agent to pay another account…' })
      setRedir({ s: 'done', v: await dashApi.redirect(job.v.job_id, fakePayee) })
    } catch (e) { setRedir(errOf(e)) }
  }

  async function checkOut() {
    try {
      setDeclined(false)
      setOutCheck({ s: 'busy', note: 'Checking who you are paying…' })
      setOutCheck({ s: 'done', v: await dashApi.checkPayee(DEMO_SELLER, payTo.trim(), payName.trim()) })
    } catch (e) { setOutCheck(errOf(e)) }
  }

  async function sponsoredCall(entrypoint: string, parameter: string) {
    const session = w.session
    if (!session?.sendSponsored || !acct) throw new WalletTooOld()
    const prep = await dashApi.prepare(acct, entrypoint, parameter)
    const hash = await session.sendSponsored(prep.transaction, prep.schema)
    const st = await waitForTx(hash)
    if (st.status === 'finalized' && st.reject) {
      const err = new Error(`The chain refused (${st.reject.name ?? 'reject'}, ${st.reject.code}).`)
      ;(err as Error & { reject: typeof st.reject }).reject = st.reject
      throw err
    }
    if (st.status !== 'finalized') throw new Error('Still waiting for the chain.')
    return hash
  }

  async function payOut(approved = false) {
    if (!w.session || !acct || outCheck.s !== 'done') return
    try {
      setOutPay({ s: 'busy', note: 'Building the payment…' })
      setOutLegs({})
      const t = await dashApi.payLinkTx(payTo.trim(), acct, amountMicro(payRail), approved, payName.trim() || undefined, undefined, payRail)
      if (t.acknowledge?.parameter) {
        if (!w.session.sendSponsored) throw new WalletTooOld()
        setOutPay({ s: 'busy', note: 'First, acknowledge this payee in your wallet. PayOnce pays the fee.' })
        const prep = await dashApi.prepare(acct, t.acknowledge.entrypoint, t.acknowledge.parameter)
        await w.session.sendSponsored(prep.transaction, prep.schema)
      }
      if (payRail === 'eudemo' || t.rail === 'eudemo') {
        if (!t.reserve || !t.transfer) throw new Error('The API did not return the EUDemo steps.')
        if (!w.session.sendSponsored) throw new WalletTooOld()
        setOutPay({ s: 'busy', note: 'Reserve this payable in your wallet. PayOnce pays the fee.' })
        const reserve = await sponsoredCall(t.reserve.entrypoint, t.reserve.parameter)
        setOutLegs((l) => ({ ...l, reserve }))
        setOutPay({ s: 'busy', note: 'Approve the EUDemo transfer. The memo names this payable. PayOnce pays the fee.' })
        const prep = await dashApi.prepareToken(acct, { recipient: t.transfer.recipient, amount: t.transfer.amount, memo: t.transfer.memo })
        const transfer = await w.session.sendSponsored(prep.transaction, prep.schema)
        const st = await waitForTx(transfer)
        if (st.reject) throw new Error(`The transfer was refused (${st.reject.name ?? 'reject'}, ${st.reject.code}).`)
        if (st.status !== 'finalized') throw new Error('Still waiting for the transfer.')
        setOutLegs((l) => ({ ...l, transfer }))
        setOutAt(Date.now())
        setOutTx(transfer)
        setOutPay({ s: 'busy', note: 'Confirm the transfer on the book. PayOnce pays the fee.' })
        const conf = await dashApi.pltConfirm(payTo.trim(), t.invoice.payable_id, transfer)
        const confirm = await sponsoredCall(conf.entrypoint, conf.parameter)
        setOutLegs((l) => ({ ...l, confirm }))
        setOutPay({ s: 'busy', note: 'Trying to reserve it again — the chain should refuse.' })
        try {
          const again = await sponsoredCall(t.replay?.entrypoint ?? 'reserve_plt', t.replay?.parameter ?? t.reserve.parameter)
          setOutLegs((l) => ({ ...l, replay: again, replayMsg: 'The chain accepted a second reserve. That should not happen; please report it.' }))
        } catch (e) {
          const r = (e as { reject?: { code: number; name?: string } }).reject ?? rejectOf(e)
          const msg = e instanceof Error ? e.message : String(e)
          setOutLegs((l) => ({ ...l, replayCode: r?.code ?? null, replayName: r?.name, replayMsg: msg }))
        }
        setOutPay({ s: 'done', v: true })
        return
      }
      if (!t.transaction) throw new Error('The API did not return a CCD payment to sign.')
      setOutPay({ s: 'busy', note: 'Approve the payment in your wallet.' })
      setOutAt(Date.now())
      setOutTx(await w.session.sendUpdate(t.transaction))
      setOutPay({ s: 'done', v: true })
    } catch (e) { setOutPay(errOf(e)) }
  }

  async function loadRecord() {
    if (!acct) return
    try { setRecord({ s: 'busy', note: 'Loading…' }); setRecord({ s: 'done', v: (await dashApi.record(acct)).items }) } catch (e) { setRecord(errOf(e)) }
  }
  useEffect(() => { if (step === 5) void loadRecord() }, [step, acct]) // eslint-disable-line react-hooks/exhaustive-deps

  const need = !acct && step > 0 ? <p className="ds-note">Connect your wallet first.</p> : null
  const balance = bal.data?.balance_ccd ?? null
  const fakePayee = useMemo(() => (acct ? lookalike(acct) : null) ?? FAKE_PAYEE, [acct])

  let card: React.ReactNode
  switch (step) {
    case 0:
      card = (
        <Card k="c0" title="Connect your wallet">
          <RunConnect />
          <p className="ds-note">No fee to connect, prove your name or become a payee — PayOnce pays those. You need some test CCD only if you later pay someone from this wallet (<a href="https://developer.concordium.software/en/mainnet/net/guides/accounts-wallets.html" target="_blank" rel="noreferrer">Concordium’s testnet faucet</a>). Concordium Wallet (browser) 2.10+ or CryptoX (Android). <a href="https://developer.concordium.software/en/mainnet/net/guides/create-identity.html" target="_blank" rel="noreferrer">No testnet identity? Guide</a></p>
          {acct ? <button className="ds-btn" onClick={() => setStep(proof ? 2 : 1)}>Continue</button> : null}
        </Card>
      )
      break
    case 1:
      card = (
        <Card k="c1" title="Prove your name">
          {need}
          {proof ? (
            <div className="ds-name" data-testid="proven-name"><small>{proof.kind === 'business' ? 'Company' : 'Person'}</small><b>{proof.name}</b><span>Proven from your wallet · {proof.version.toUpperCase()}</span></div>
          ) : (
            <>
              <div className="ds-toggle" role="radiogroup" aria-label="Who gets paid">
                {(['person', 'business'] as const).map((k) => (
                  <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{k === 'person' ? 'Person' : 'Company'}</button>
                ))}
              </div>
              <button className="ds-btn" disabled={!acct || prove.s === 'busy'} onClick={() => void proveName()}>Prove my name</button>
              {prove.s === 'busy' ? <button className="ds-btn ds-btn--ghost" type="button" onClick={cancelProve}>Cancel and try again</button> : null}
              <State a={prove} />
              <p className="ds-note">Shares the name only, never the ID number. Testnet names are mock identities.</p>
            </>
          )}
          {proof ? <button className="ds-btn" onClick={() => setStep(2)}>Continue</button> : null}
        </Card>
      )
      break
    case 2:
      card = (
        <Card k="c2" title="Become a payee">
          {need}
          <div className="ds-kv">
            <span>Fee</span><b>0 CCD · paid by PayOnce</b>
            <span>Your balance</span><b className="tabular">{balance != null ? `${balance} CCD` : '…'}</b>
          </div>
          {bound ? (
            <>
              <Stamp verdict="MATCH" sub="Bound by your signature" />
              {acct ? <p className="ds-link">Your link <Link to={`/p/${acct}`}><code>payonce…/p/{short(acct)}</code></Link></p> : null}
              <button className="ds-btn" onClick={() => setStep(3)}>Get paid</button>
            </>
          ) : (
            <>
              <button className="ds-btn" disabled={!acct || !proof || bind.s === 'busy'} onClick={() => void becomePayee()}>Sign once, 0 CCD</button>
              {bindTx ? <ChainBar phase={bindSt.phase} startedAt={bindAt} /> : null}
              {bindTx ? <Tx hash={bindTx} label="accept_payee" /> : null}
              <State a={bind} />
            </>
          )}
        </Card>
      )
      break
    case 3: {
      const j = job.s === 'done' ? job.v : null
      card = (
        <Card k="c3" title="Get paid">
          {need}
          {!j ? (
            <>
              <label className="ds-field"><span>Your invoice</span><textarea rows={4} value={invoice} onChange={(e) => setInvoice(e.target.value)} /></label>
              <button className="ds-btn" disabled={!acct || job.s === 'busy'} onClick={() => void getPaid()}>Send it to the agent</button>
              <State a={job} />
            </>
          ) : (
            <div className="ds-run">
              {j.check ? <VerdictBlock check={j.check} /> : null}
              {j.stage === 'hold' && j.hold_ends_at ? <HoldRing endsAt={j.hold_ends_at} totalSecs={90} /> : null}
              {j.stage === 'hold' ? <p className="ds-note">Demo book: 90 s hold. Production: 24 h+, set at init.</p> : null}
              {j.pay_tx ? <PayTx hash={j.pay_tx} /> : null}
              {j.stage === 'paid' ? <p className="ds-big">+{j.amount_display}<small>from {j.payer_label}</small></p> : null}
              {j.error ? <p className="ds-err">{j.error}</p> : null}
              {j.stage !== 'paid' && redir.s === 'idle' ? <button className="ds-btn ds-btn--ghost" onClick={() => void tryRedirect()}>Try to redirect your payment</button> : null}
              {redir.s === 'done' && acct ? (
                <div className="ds-redir">
                  <PayeeDiff real={acct} asked={fakePayee} illustration />
                  <VerdictBlock check={redir.v.check} />
                  {redir.v.refusal ? <Tx hash={redir.v.refusal.tx_hash} label={`Chain refused (${redir.v.refusal.code})`} /> : <p className="ds-note">Nothing sent.</p>}
                </div>
              ) : <State a={redir} />}
              {j.stage === 'paid' ? <button className="ds-btn" onClick={() => setStep(4)}>Now you pay</button> : null}
            </div>
          )}
        </Card>
      )
      break
    }
    case 4:
      card = (
        <Card k="c4" title="Now you pay">
          {need}
          <div className="ds-two">
            <div className="ds-pane">
              <h3>A payee link</h3>
              <div className="ds-toggle" role="radiogroup" aria-label="Pay in">
                {(['ccd', 'eudemo'] as const).map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={payRail === r} className={payRail === r ? 'is-on' : ''} onClick={() => { setPayRail(r); setOutPay({ s: 'idle' }); setOutLegs({}); setOutTx(null) }}>{r === 'ccd' ? 'CCD' : 'EUDemo'}</button>
                ))}
              </div>
              {payRail === 'eudemo' ? (
                <p className="ds-note">0.01 EUDemo, once. Reserve, then a token transfer whose memo names the payable, then confirm. PayOnce pays the fees. Both accounts must be on Concordium’s EUDemo allow list (lab accounts are; a new wallet needs to be added first). <a href={EUDEMO_EVIDENCE} target="_blank" rel="noreferrer">A completed run</a> was refused on re-reserve (−16).</p>
              ) : (
                <p className="ds-note">1 CCD, once, paid from your wallet.</p>
              )}
              <label className="ds-field"><span>Account</span><input value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="Paste a Concordium account" spellCheck={false} /></label>
              <label className="ds-field"><span>Name on the invoice</span><input value={payName} onChange={(e) => setPayName(e.target.value)} placeholder="Nour Design Studio" /></label>
              <button className="ds-btn" disabled={!payTo.trim() || !payName.trim() || outCheck.s === 'busy'} onClick={() => void checkOut()}>Check payee</button>
              <State a={outCheck}>{(c) => (
                <>
                  <VerdictBlock check={c} />
                  {c.payable ? <button className="ds-btn" disabled={!acct || outPay.s === 'busy'} onClick={() => void payOut()}>Pay {amountLabel(payRail)}</button> : null}
                  {c.verdict === 'NO_MATCH' ? <p className="ds-note">The agent pays nothing. No override.</p> : null}
                  {c.verdict === 'UNVERIFIED' && !c.payable ? <p className="ds-note">Not possible: the book cannot record an acknowledgment for this payee, so the chain would refuse the payment. Nothing to sign.</p> : null}
                  {!c.payable && (c.verdict === 'CLOSE_MATCH' || c.verdict === 'MATCH') && !declined && !outTx ? (
                    <HumanGate
                      outcome={c.verdict === 'CLOSE_MATCH' ? 'close_match' : 'match_unbound'}
                      why={reasonFor(c) ?? 'The agent cannot confirm this payee on its own.'}
                      facts={[
                        { label: 'Name on invoice', value: payName.trim() },
                        { label: 'Proven name', value: c.verified_name ?? 'none' },
                        { label: 'Account', value: short(payTo.trim()) },
                        { label: 'Amount', value: `${amountLabel(payRail)}, once` },
                      ]}
                      confirmLabel={`Pay ${amountLabel(payRail)} anyway`}
                      busy={outPay.s === 'busy' || !acct}
                      onApprove={() => void payOut(true)}
                      onDecline={() => setDeclined(true)}
                    />
                  ) : null}
                  {declined ? <p className="ds-note">You decided not to pay. Nothing was sent.</p> : null}
                  {outTx ? <><ChainBar phase={outSt.phase} startedAt={outAt} /><Tx hash={outTx} label={payRail === 'eudemo' ? 'EUDemo transfer' : 'Payment'} /></> : null}
                  {outLegs.reserve ? <Tx hash={outLegs.reserve} label="reserve_plt" /> : null}
                  {outLegs.confirm ? <Tx hash={outLegs.confirm} label="confirm_plt" /> : null}
                  {outLegs.replayCode === -16 || (outLegs.replayMsg && outLegs.replayCode != null) ? (
                    <p className="ds-note" data-testid="eudemo-replay">{outLegs.replay ? <Tx hash={outLegs.replay} label={`Re-reserve refused (${outLegs.replayCode}${outLegs.replayName ? `, ${outLegs.replayName}` : ''})`} /> : <>Re-reserve refused{outLegs.replayCode != null ? ` (${outLegs.replayCode}${outLegs.replayName ? `, ${outLegs.replayName}` : ''})` : ''}. The payable is already paid.</>}</p>
                  ) : outLegs.replayMsg ? <p className="ds-err">{outLegs.replayMsg}</p> : null}
                  {payRail === 'eudemo' && outPay.s === 'done' && outLegs.replayCode !== -16 ? (
                    <p className="ds-note">The first completed run was refused on re-reserve (−16): <Tx hash={EUDEMO_REPLAY_TX} label="recorded refusal" />.</p>
                  ) : null}
                  <State a={outPay} />
                </>
              )}</State>
            </div>
            <div className="ds-pane">
              <h3>A paid service</h3>
              <Services />
            </div>
          </div>
          <button className="ds-btn ds-btn--ghost" onClick={() => setStep(5)}>Your record</button>
        </Card>
      )
      break
    default:
      card = (
        <Card k="c5" title="Your record">
          {need}
          <State a={record}>{(items) => items.length === 0 ? <p className="ds-note">Nothing yet.</p> : (
            <ul className="ds-record">{items.map((r) => (
              <li key={`${r.at}-${r.role}-${r.counterparty}-${r.tx_hash ?? 'none'}`}><span className={`ds-dot ds-dot--${r.role}`} /><b>{r.role === 'received' ? '+' : r.role === 'paid' ? '−' : '×'}{r.amount_display}</b><span>{short(r.counterparty)}</span><span>{r.verdict.replace('_', ' ').toLowerCase()}</span>{r.tx_hash ? <Tx hash={r.tx_hash} label="tx" /> : <span>nothing sent</span>}</li>
            ))}</ul>
          )}</State>
          <p className="ds-note"><Link to="/app/proof/judges">Verify it yourself</Link>, no keys needed.</p>
        </Card>
      )
  }

  return (
    <div className="ds" data-testid="dash">
      <header className="ds-hero">
        <h1 className="ds-h1">Get paid. Then pay.</h1>
        <p className="ds-lead">Your wallet, your name, real testnet money.</p>
        <Rail step={step} done={done} go={setStep} canGo={(n) => n < 3 || bound} />
      </header>
      <div className="ds-body">
        <AnimatePresence mode="wait">{card}</AnimatePresence>
      </div>
    </div>
  )
}

function PayTx({ hash }: { hash: string }) {
  const st = useTxStatus(hash)
  const [at] = useState(Date.now())
  return <><ChainBar phase={st.phase} startedAt={at} /><Tx hash={hash} label="Payment" /></>
}

export function DashPage() {
  return <WalletProvider><Flow /></WalletProvider>
}
