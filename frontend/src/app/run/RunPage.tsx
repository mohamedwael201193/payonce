// /app: the one guided flow. A judge runs it end to end on a real testnet invoice:
// payer -> invoice -> the agent's check (Match / No match) -> approve -> paid once -> receipt.
// One step card at a time, one primary action per step, and every state says what is happening.
// Every value shown comes from a live API call made on this visit; nothing is typed by hand.
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { sha256Hex } from '../../landing/sha256'
import type { JobSnapshot, VerifyResponse } from '../../lib/types'
import { AGENTS, badgeCheckUrl } from '../identity'
import { midTruncate } from '../Address'
import { useDocumentTitle } from '../hooks'
import { STEPS, forgePayee, tidy, toVerdict, type StepIndex, type Verdict } from './flow'
import { VerdictMark } from './Visuals'
import { WalletProvider, useWallet } from '../../wallet/WalletContext'
import { walletApi, waitForTx, WalletApiError } from '../../wallet/api'
import { walletErrorText, type UpdateTx } from '../../wallet/types'
import { RunConnect, RunFunds, useFunded } from './RunWallet'
import './run.css'

const EXPLORER = 'https://ccdexplorer.io/testnet/transaction/'
const PAYER = AGENTS.find((a) => a.key === 'buyer')!

interface Invoice {
  id: number
  seller: string
  payee: string
  amount: string
  regTx: string | null
  doc: string
}

type Payer = 'wallet' | 'agent'
interface WalletInvoice { seller: string; payable_id: number; tx_hash?: string | null }
interface PayTx { invoice: { payable_id: number; seller: string; payee: string; amount_ccd: string }; transaction: UpdateTx }
const invoiceKey = (acct: string) => `payonce.wallet.invoice.${acct}`
const REJECT_PLAIN: Record<string, string> = {
  WrongStatus: 'This invoice is already paid, so the contract refused a second payment. Nothing moved.',
  WrongPayer: 'Only the account named on the invoice may pay it.',
  PastDue: 'The invoice is past due.',
  WrongAmount: 'The amount does not match the invoice.',
}
function rejectText(r: { code: number; name: string; message?: string } | null | undefined): string {
  if (!r) return 'The chain refused the transaction. Nothing moved.'
  return `${REJECT_PLAIN[r.name] ?? r.message ?? 'The contract refused it. Nothing moved.'} (${r.name}, code ${r.code})`
}

type Async<T> = { s: 'idle' } | { s: 'busy'; note: string } | { s: 'done'; v: T } | { s: 'error'; msg: string }

function errText(e: unknown): string {
  const b = (e as { body?: { message?: string } } | null)?.body
  return b?.message ?? (e instanceof Error ? e.message : '') ?? 'Something went wrong.'
}
const short = (a: string) => midTruncate(a, 6, 6)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function RunPage() {
  return (
    <WalletProvider>
      <RunFlow />
    </WalletProvider>
  )
}

function RunFlow() {
  useDocumentTitle('Run it')
  const w = useWallet()
  const acct = w.session?.account ?? null
  const funded = useFunded(acct)
  const [payer, setPayer] = useState<Payer | null>(null)
  // Default: the visitor's own wallet on a phone or when the extension is installed; else the testnet buyer agent.
  const choice: Payer = payer ?? (w.session || w.mobile || w.browserWallet ? 'wallet' : 'agent')
  const mine = choice === 'wallet'
  const [walletTx, setWalletTx] = useState<PayTx | null>(null)
  const [step, setStep] = useState<StepIndex>(0)
  const [invoice, setInvoice] = useState<Async<Invoice>>({ s: 'idle' })
  const [fake, setFake] = useState(false)
  const [check, setCheck] = useState<Async<Verdict>>({ s: 'idle' })
  const [pay, setPay] = useState<Async<{ tx: string | null; job: JobSnapshot | null }>>({ s: 'idle' })
  const [again, setAgain] = useState<Async<{ plain: string; tx: string | null }>>({ s: 'idle' })
  const [review, setReview] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])
  // The invoice lives in the URL (?invoice=<id>&seller=<account>): a refresh or a shared link comes back to it,
  // and an invoice that is already paid goes straight to its receipt.
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const id = Number(params.get('invoice'))
    const seller = params.get('seller')
    if (!Number.isInteger(id) || id < 1 || !seller) return
    setInvoice({ s: 'busy', note: 'Loading your invoice from the chain.' })
    setStep(1)
    void (async () => {
      try {
        const facts = await api.getPayable(id, seller)
        if (facts.status.kind === 'paid') { navigate(`/app/receipt/${encodeURIComponent(seller)}/${id}`, { replace: true }); return }
        const doc = await api.getDocument(id, seller)
        if (!alive.current) return
        setInvoice({ s: 'done', v: { id, seller: facts.seller, payee: facts.payee, amount: tidy(facts.amount_display), regTx: null, doc } })
      } catch (e) {
        if (alive.current) setInvoice({ s: 'error', msg: `That invoice link could not be loaded. ${errText(e)}` })
      }
    })()
  }, [params, navigate])
  const remember = (v: Invoice) => setParams({ invoice: String(v.id), seller: v.seller }, { replace: true })

  const inv = invoice.s === 'done' ? invoice.v : null
  const verdict = check.s === 'done' ? check.v : null

  async function loadInvoice(seller: string, id: number, regTx: string | null) {
    const facts = await api.getPayable(id, seller)
    const doc = await api.getDocument(id, seller)
    return { id, seller: facts.seller, payee: facts.payee, amount: tidy(facts.amount_display), regTx, doc }
  }

  async function getWalletInvoice() {
    if (!acct) return
    setInvoice({ s: 'busy', note: 'Registering an invoice that names your account as the only payer. About 10 seconds.' })
    setWalletTx(null)
    try {
      const r = await walletApi<WalletInvoice>('/api/wallet/invoice', { method: 'POST', body: { payer: acct } })
      try { localStorage.setItem(invoiceKey(acct), JSON.stringify({ seller: r.seller, payable_id: r.payable_id, tx_hash: r.tx_hash ?? null })) } catch { /* private mode */ }
      const v = await loadInvoice(r.seller, r.payable_id, r.tx_hash ?? null)
      if (alive.current) setInvoice({ s: 'done', v })
    } catch (e) {
      // Limited per account and per day: reuse this account's last invoice while it is still payable.
      try {
        const raw = localStorage.getItem(invoiceKey(acct))
        const last = raw ? (JSON.parse(raw) as WalletInvoice) : null
        if (!last) throw e
        await walletApi<PayTx>(`/api/wallet/pay-tx?seller=${last.seller}&id=${last.payable_id}&account=${acct}`)
        const v = await loadInvoice(last.seller, last.payable_id, last.tx_hash ?? null)
        if (alive.current) setInvoice({ s: 'done', v })
      } catch {
        if (alive.current) setInvoice({ s: 'error', msg: e instanceof WalletApiError ? e.message : errText(e) })
      }
    }
  }

  async function getInvoice() {
    if (mine) return getWalletInvoice()
    setInvoice({ s: 'busy', note: 'Registering a new invoice on Concordium testnet. This usually takes 30 to 60 seconds.' })
    try {
      const created = await api.createPayable('ccd')
      const facts = await api.getPayable(created.payable_id, AGENTS[0].owner)
      const doc = await api.getDocument(created.payable_id, facts.seller)
      if (!alive.current) return
      const v = { id: created.payable_id, seller: facts.seller, payee: facts.payee, amount: tidy(facts.amount_display), regTx: created.tx_hash, doc }
      setInvoice({ s: 'done', v })
      remember(v)
    } catch (e) {
      // New invoices are rate limited. Fall back to an open demo invoice that is already on chain.
      try {
        const rows = await api.getInvoices()
        const open = rows.find((r) => r.status === 'unpaid' && r.asset === 'ccd' && r.kind === 'demo' && new Date(r.due).getTime() > Date.now())
        if (!open) throw e
        const facts = await api.getPayable(open.payable_id, open.seller)
        const doc = await api.getDocument(open.payable_id, open.seller)
        if (!alive.current) return
        const v = { id: open.payable_id, seller: open.seller, payee: facts.payee, amount: tidy(facts.amount_display), regTx: null, doc }
        setInvoice({ s: 'done', v })
        remember(v)
      } catch {
        if (alive.current) setInvoice({ s: 'error', msg: errText(e) })
      }
    }
  }

  async function runCheck() {
    if (!inv) return
    setStep(2)
    setCheck({ s: 'busy', note: 'The agent is reading the invoice back from the chain.' })
    try {
      const sent = fake ? forgePayee(inv.doc) : inv.doc
      const res: VerifyResponse = await api.verify(inv.id, 'before_pay', sha256Hex(sent), inv.seller)
      if (alive.current) setCheck({ s: 'done', v: toVerdict(res) })
    } catch (e) {
      if (alive.current) setCheck({ s: 'error', msg: errText(e) })
    }
  }

  async function openReview() {
    if (!inv) return
    if (!mine) return setReview(true)
    if (!acct) return
    try {
      const t = await walletApi<PayTx>(`/api/wallet/pay-tx?seller=${inv.seller}&id=${inv.id}&account=${acct}`)
      setWalletTx(t)
      setReview(true)
    } catch (e) {
      setStep(3)
      setPay({ s: 'error', msg: e instanceof WalletApiError ? e.message : errText(e) })
    }
  }

  async function walletPay() {
    if (!inv || !w.session || !walletTx) return
    setReview(false)
    setStep(3)
    setPay({ s: 'busy', note: 'Approve the payment in your wallet.' })
    try {
      const hash = await w.session.sendUpdate(walletTx.transaction)
      if (alive.current) setPay({ s: 'busy', note: 'Sent from your wallet. The chain takes about 10 seconds to finalise it.' })
      const st = await waitForTx(hash)
      if (!alive.current) return
      if (st.status === 'finalized' && !st.reject) {
        setPay({ s: 'done', v: { tx: hash, job: null } })
        setStep(4)
      } else if (st.reject) {
        setPay({ s: 'error', msg: rejectText(st.reject) })
      } else {
        setPay({ s: 'error', msg: 'Still waiting for the chain. Open the receipt in a minute; do not pay again.' })
      }
    } catch (e) {
      if (alive.current) setPay({ s: 'error', msg: walletErrorText(e) })
    }
  }

  async function walletPayAgain() {
    if (!w.session || !walletTx) return
    setAgain({ s: 'busy', note: 'Approve the second payment in your wallet. The contract decides.' })
    try {
      const hash = await w.session.sendUpdate(walletTx.transaction)
      const st = await waitForTx(hash)
      if (!alive.current) return
      if (st.reject) setAgain({ s: 'done', v: { plain: rejectText(st.reject), tx: hash } })
      else setAgain({ s: 'error', msg: st.status === 'finalized' ? 'The chain accepted a second payment. This should never happen; please report it.' : 'Still waiting for the chain.' })
    } catch (e) {
      if (alive.current) setAgain({ s: 'error', msg: walletErrorText(e) })
    }
  }

  const paying = useRef(false)
  async function approveAndPay() {
    if (!inv || paying.current) return
    paying.current = true
    if (mine) {
      try { return await walletPay() } finally { paying.current = false }
    }
    setReview(false)
    setStep(3)
    setPay({ s: 'busy', note: 'Sending the payment. The chain usually needs 10 to 30 seconds to finalise it.' })
    try {
      const job = await api.pay(inv.id, 'ccd', sha256Hex(inv.doc), inv.seller)
      let snap = await api.getJob(job.job_id)
      for (let i = 0; i < 90 && snap.state === 'running'; i++) {
        await sleep(2000)
        if (!alive.current) return
        snap = await api.getJob(job.job_id)
      }
      if (!alive.current) return
      if (snap.state === 'succeeded') {
        const tx = [...snap.steps].reverse().find((x) => x.txHash)?.txHash ?? null
        setPay({ s: 'done', v: { tx, job: snap } })
        setStep(4)
      } else if (snap.state === 'running') {
        setPay({ s: 'error', msg: 'Still waiting for the chain. Open the receipt in a minute; do not pay again.' })
      } else {
        const bad = snap.steps.find((x) => x.status === 'failed' || x.status === 'refused')
        setPay({ s: 'error', msg: bad?.reject?.plain ?? bad?.detail ?? 'The payment did not go through. Nothing was paid.' })
      }
    } catch (e) {
      if (alive.current) setPay({ s: 'error', msg: errText(e) })
    } finally {
      paying.current = false
    }
  }

  async function payAgain() {
    if (!inv) return
    if (mine) return walletPayAgain()
    setAgain({ s: 'busy', note: 'Sending a second payment for the same invoice to the chain.' })
    try {
      const r = await api.attack('pay_twice', inv.id, undefined, inv.seller)
      if (alive.current) setAgain({ s: 'done', v: { plain: 'The chain refused it: this invoice is already paid. Nothing moved.', tx: r.tx_hash ?? null } })
    } catch (e) {
      if (alive.current) setAgain({ s: 'error', msg: errText(e) })
    }
  }

  function restart() {
    setParams({}, { replace: true })
    setStep(0); setInvoice({ s: 'idle' }); setFake(false); setCheck({ s: 'idle' }); setPay({ s: 'idle' }); setAgain({ s: 'idle' }); setWalletTx(null)
  }

  const blocked = verdict?.kind === 'no_match'

  return (
    <div className="rn">
      <header className="rn-head">
        <h1 className="rn-h1">Your AI agent checks who it’s paying.</h1>
        <p className="rn-lead">Match or No match, before any money moves. Then it pays exactly once. Try it on a real testnet invoice.</p>
      </header>

      <ol className="rn-steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={blocked && i === 2 ? 'is-bad' : i < step ? 'is-done' : i === step ? 'is-now' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="rn-steps__n">{i + 1}</span>
            <span className="rn-steps__l">{label}</span>
          </li>
        ))}
      </ol>

      <p className="rn-stepnow" aria-hidden>Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>

      <Card k={`${step}-${check.s}-${verdict?.kind ?? ''}`}>
        {step === 0 && (
          <>
            <h2 className="rn-h2">Who pays?</h2>
            <fieldset className="rn-choice">
              <legend>Choose the payer</legend>
              <label className={mine ? 'is-on' : ''}>
                <input type="radio" name="payer" checked={mine} onChange={() => setPayer('wallet')} />
                <span><b>My own wallet</b>{w.mobile ? 'CryptoX on this phone.' : 'Concordium Wallet (browser) here, or CryptoX on your phone.'} You sign the payment yourself.</span>
              </label>
              <label className={!mine ? 'is-on' : ''}>
                <input type="radio" name="payer" checked={!mine} onChange={() => setPayer('agent')} />
                <span><b>PayOnce’s buyer agent</b>No wallet needed. A server key signs for agent #{PAYER.token}.</span>
              </label>
            </fieldset>
            {mine ? (
              <>
                <RunConnect />
                {acct && w.session?.chainOk !== false && <RunFunds account={acct} />}
                <div className="rn-actions">
                  <button className="rn-btn" disabled={!acct || !funded || w.session?.chainOk === false} onClick={() => { setInvoice({ s: 'idle' }); setStep(1) }}>
                    Continue with this account
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="rn-p" style={{ marginTop: 18 }}>
                  The payer is PayOnce’s buyer agent on testnet, account <Mono>{short(PAYER.owner)}</Mono>, agent{' '}
                  <a className="rn-a" href={badgeCheckUrl(PAYER.badge)} target="_blank" rel="noreferrer">#{PAYER.token}</a> on the official Concordium registry.
                </p>
                <div className="rn-actions">
                  <button className="rn-btn" onClick={() => setStep(1)}>Use the testnet buyer agent</button>
                </div>
              </>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="rn-h2">Get a real invoice</h2>
            {invoice.s === 'idle' && (
              <>
                <p className="rn-p">
                  A seller agent registers a small invoice on chain: amount, due date, the account to pay and a fingerprint of the document.
                  {mine && acct && <> It names your account <Mono>{short(acct)}</Mono> as the only payer.</>}
                </p>
                <div className="rn-actions"><button className="rn-btn" onClick={getInvoice}>Get an invoice</button></div>
              </>
            )}
            {invoice.s === 'busy' && <Busy note={invoice.note} />}
            {invoice.s === 'error' && <Failed msg={invoice.msg} retry={getInvoice} />}
            {inv && (
              <>
                <dl className="rn-kv">
                  <div><dt>Invoice</dt><dd>#{inv.id}</dd></div>
                  <div><dt>Amount</dt><dd>{inv.amount}</dd></div>
                  <div><dt>Pay to</dt><dd><Mono>{short(inv.payee)}</Mono></dd></div>
                  <div><dt>On chain</dt><dd>{inv.regTx ? <a className="rn-a" href={EXPLORER + inv.regTx} target="_blank" rel="noreferrer">Registration {inv.regTx.slice(0, 8)}</a> : 'Open demo invoice'}</dd></div>
                </dl>
                <fieldset className="rn-choice">
                  <legend>What does the agent receive?</legend>
                  <label className={!fake ? 'is-on' : ''}>
                    <input type="radio" name="variant" checked={!fake} onChange={() => setFake(false)} />
                    <span><b>The invoice as sent</b>The real document.</span>
                  </label>
                  <label className={fake ? 'is-on' : ''}>
                    <input type="radio" name="variant" checked={fake} onChange={() => setFake(true)} />
                    <span><b>A fake</b>Same invoice, but it asks to pay <Mono>{short(forgePayee(inv.doc).match(/^Payee:\s*(\S+)/m)?.[1] ?? '')}</Mono>.</span>
                  </label>
                </fieldset>
                <div className="rn-actions"><button className="rn-btn" onClick={runCheck}>Let the agent check it</button></div>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            {check.s === 'busy' && <><h2 className="rn-h2">Checking who it’s paying</h2><Busy note={check.note} /></>}
            {check.s === 'error' && <><h2 className="rn-h2">The check did not finish</h2><Failed msg={check.msg} retry={runCheck} /></>}
            {verdict && <VerdictView v={verdict} onPay={() => void openReview()} onRestart={restart} onReal={() => { setFake(false); setStep(1); setCheck({ s: 'idle' }) }} receipt={inv ? `/app/receipt/${inv.seller}/${inv.id}` : null} />}
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="rn-h2">Paying once</h2>
            {pay.s === 'busy' && <Busy note={pay.note} />}
            {pay.s === 'error' && <Failed msg={pay.msg} retry={inv ? () => setStep(2) : undefined} retryLabel="Back to the check" />}
          </>
        )}

        {step === 4 && inv && pay.s === 'done' && (
          <>
            <div className="rn-verdict rn-verdict--ok">
              <VerdictMark kind="paid" />
              <div>
                <p className="rn-verdict__word">Paid once</p>
                <p className="rn-p">{inv.amount} went to <Mono>{short(inv.payee)}</Mono>, the account the seller registered.</p>
              </div>
            </div>
            <div className="rn-actions">
              <Link className="rn-btn" to={`/app/receipt/${inv.seller}/${inv.id}`}>Open the receipt</Link>
              {pay.v.tx && <a className="rn-btn rn-btn--quiet" href={EXPLORER + pay.v.tx} target="_blank" rel="noreferrer">See it on CCDExplorer</a>}
            </div>
            <div className="rn-again">
              <h3 className="rn-h3">Now try to pay it again</h3>
              {again.s === 'idle' && <button className="rn-btn rn-btn--quiet" onClick={payAgain}>{mine ? 'Send the same payment again from my wallet' : 'Send a second payment'}</button>}
              {again.s === 'busy' && <Busy note={again.note} />}
              {again.s === 'error' && <Failed msg={again.msg} retry={payAgain} />}
              {again.s === 'done' && (
                <p className="rn-p rn-refused">
                  {again.v.plain} A refused attempt costs a small testnet fee.{' '}
                  {again.v.tx && <a className="rn-a" href={EXPLORER + again.v.tx} target="_blank" rel="noreferrer">The rejected transaction</a>}
                </p>
              )}
            </div>
            <button className="rn-link" onClick={restart}>Start again</button>
          </>
        )}
      </Card>

      {review && inv && <ReviewSheet inv={inv} from={mine && acct ? <>Your account <Mono>{short(acct)}</Mono>, signed in your wallet</> : null} onCancel={() => setReview(false)} onConfirm={approveAndPay} />}

      <p className="rn-foot">
        Want to be paid instead? <Link className="rn-a" to="/app/sell">Become a verified payee</Link>.{' '}
        Testnet only: test CCD, demo identities. Every step above is a real transaction you can{' '}
        <Link className="rn-a" to="/app/proof/judges#verify-it">verify yourself</Link>. More evidence: <Link className="rn-a" to="/app/proof">Proof</Link>.
      </p>
    </div>
  )
}

function Card({ k, children }: { k: string; children: React.ReactNode }) {
  const still = useReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.section
        key={k}
        className="rn-card"
        initial={still ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={still ? undefined : { opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        aria-live="polite"
      >
        {children}
      </motion.section>
    </AnimatePresence>
  )
}

function VerdictView({ v, onPay, onRestart, onReal, receipt }: { v: Verdict; onPay: () => void; onRestart: () => void; onReal: () => void; receipt: string | null }) {
  const ok = v.kind === 'match'
  return (
    <>
      <div className={`rn-verdict ${v.kind === 'no_match' ? 'rn-verdict--bad' : 'rn-verdict--ok'}`} data-testid="run-verdict">
        <VerdictMark kind={v.kind} />
        <div>
          <p className="rn-verdict__word">{v.kind === 'match' ? 'Match' : v.kind === 'no_match' ? 'No match' : 'Already paid'}</p>
          <p className="rn-p">{v.kind === 'match' ? 'Safe to pay. The agent may go ahead.' : v.kind === 'no_match' ? `${v.headline} Nothing was sent.` : 'This invoice was paid before. Nothing more will be sent.'}</p>
        </div>
      </div>
      <ul className="rn-reasons">
        {v.reasons.map((r) => (
          <li key={r.text} className={r.ok ? 'is-ok' : 'is-bad'}>{r.text}</li>
        ))}
      </ul>
      <div className="rn-actions">
        {ok && <button className="rn-btn" onClick={onPay} autoFocus>Approve and pay</button>}
        {v.kind === 'no_match' && <button className="rn-btn" onClick={onReal} autoFocus>Check the real invoice</button>}
        {v.kind === 'paid' && receipt && <Link className="rn-btn" to={receipt}>Open the receipt</Link>}
        <button className="rn-link" onClick={onRestart}>Start again</button>
      </div>
    </>
  )
}

function ReviewSheet({ inv, from, onCancel, onConfirm }: { inv: Invoice; from?: React.ReactNode; onCancel: () => void; onConfirm: () => void }) {
  const btn = useRef<HTMLButtonElement>(null)
  const openedAt = useRef(Date.now())
  // A double-click on "Approve and pay" lands its second click on the scrim: ignore clicks in the first half second.
  const safeCancel = () => { if (Date.now() - openedAt.current > 500) onCancel() }
  useEffect(() => {
    btn.current?.focus()
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCancel])
  return (
    <div className="rn-scrim" onClick={safeCancel}>
      <div className="rn-sheet" role="dialog" aria-modal="true" aria-labelledby="rn-sheet-h" onClick={(e) => e.stopPropagation()}>
        <h2 className="rn-h2" id="rn-sheet-h">Pay {inv.amount}?</h2>
        <dl className="rn-kv">
          <div><dt>To</dt><dd><Mono>{inv.payee}</Mono></dd></div>
          <div><dt>Invoice</dt><dd>#{inv.id}</dd></div>
          <div><dt>From</dt><dd>{from ?? <>Buyer agent #{PAYER.token}</>}</dd></div>
        </dl>
        <p className="rn-note">The contract pays this exact amount to this account, once. A second payment is refused by the chain.</p>
        <div className="rn-actions">
          <button className="rn-btn" ref={btn} onClick={onConfirm}>{from ? 'Pay from my wallet' : 'Approve and pay'}</button>
          <button className="rn-link" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Busy({ note }: { note: string }) {
  return (
    <p className="rn-busy" role="status">
      <span className="rn-spin" aria-hidden />
      {note}
    </p>
  )
}

function Failed({ msg, retry, retryLabel = 'Try again' }: { msg: string; retry?: () => void; retryLabel?: string }) {
  return (
    <div className="rn-failed" role="alert">
      <p>{msg}</p>
      {retry && <button className="rn-btn rn-btn--quiet" onClick={retry}>{retryLabel}</button>}
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="rn-mono">{children}</span>
}
