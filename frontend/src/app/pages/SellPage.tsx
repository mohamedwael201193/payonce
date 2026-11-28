// /app/sell — become a payee from your own wallet, then let PayOnce's buyer agent pay you.
// Every chain write is signed in YOUR wallet: the agent registration on Concordium's official CIS-8004 registry
// (two transactions: mint, then pin the badged card), the listing signature, and the invoice registration.
// PayOnce's buyer then writes its own capped vendor row for you, and its agent pays your invoice exactly once.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDocumentTitle } from '../hooks'
import { Button, ButtonLink, Card, Notice, StatusPill } from '../ui'
import { Address } from '../Address'
import { WalletProvider, useWallet } from '../../wallet/WalletContext'
import { ConnectWallet, TestCcdHelper, TxLine, useAccountInfo, type StepState } from '../../wallet/WalletUI'
import { SellStep as Step } from '../../dash/SellStep'
import '../../dash/dash.css'
import { walletApi, waitForTx, WalletApiError } from '../../wallet/api'
import { walletErrorText, type UpdateTx } from '../../wallet/types'
import { PayeeProof } from '../../wallet/PayeeProof'

interface Agent { token_id: number; token_address?: string; status?: string; badge_valid: boolean | null; badge_issues?: unknown[]; agent_uri?: string }
interface OpenInvoice { seller: string; payable_id: number; amount_ccd: string; payee: string; due: string; description: string; status: string; register_tx: string | null; payment: { txs?: Array<{ step?: string; tx_hash?: string; label?: string }> } | null; receipt_url: string }
interface Status {
  account: string
  agents: Agent[]
  agents_error: string | null
  card_draft: { card_url: string; stage: string; token_id: number | null } | null
  listed: boolean
  listing: { agent_token: number; tx_hash: string; tier: number; caps: { per_payable_ccd: string; period_ccd: string } } | null
  invoices: OpenInvoice[]
}
type ServerTx = Omit<UpdateTx, 'amount_micro'> & { amount_micro?: string; amount_micro_ccd?: string }
const toTx = (t: ServerTx): UpdateTx => ({ ...t, amount_micro: String(t.amount_micro ?? t.amount_micro_ccd ?? '0') })
const errText = (e: unknown) => (e instanceof WalletApiError ? e.message : walletErrorText(e))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function useSellerStatus(account: string | null) {
  return useQuery({
    queryKey: ['open-status', account],
    enabled: Boolean(account),
    queryFn: () => walletApi<Status>(`/api/open/sellers/${account}`),
    refetchInterval: 20_000,
  })
}

function AgentStep({ account, status, onChange }: { account: string; status: Status; onChange: () => Promise<unknown> }) {
  const w = useWallet()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [txs, setTxs] = useState<Array<{ label: string; hash: string }>>([])
  const good = status.agents.find((a) => a.badge_valid === true && (a.status ?? 'Active') === 'Active')
  const unbadged = status.agents.find((a) => a.badge_valid !== true)

  const pinCard = useCallback(async (tokenId: number) => {
    if (!w.session) return
    setBusy('Preparing the badged agent card…')
    const fin = await walletApi<{ transaction: ServerTx }>('/api/open/agent-card/finalize', { method: 'POST', body: { owner: account, token_id: tokenId } })
    setBusy('Approve "set agent URI" in your wallet (transaction 2 of 2)…')
    const h2 = await w.session.sendUpdate(toTx(fin.transaction))
    setTxs((t) => [...t, { label: 'Card pinned (setAgentURI)', hash: h2 }])
    setBusy('Waiting for the testnet…')
    const s2 = await waitForTx(h2)
    if (s2.reject) throw new Error(`The registry refused setAgentURI (${s2.reject.name}).`)
    setBusy('Checking the official badge…')
    for (let i = 0; i < 8; i++) {
      const st = (await onChange()) as { data?: Status } | undefined
      if (st?.data?.agents.some((a) => a.token_id === tokenId && a.badge_valid === true)) break
      await sleep(4000)
    }
  }, [account, onChange, w.session])

  async function register() {
    if (!w.session) return
    setErr(null)
    try {
      setBusy('Building your agent card with the official Agent Registry tools…')
      const start = await walletApi<{ transaction: ServerTx; card_url: string }>('/api/open/agent-card', { method: 'POST', body: { owner: account, name, description: desc } })
      const before = new Set(status.agents.map((a) => a.token_id))
      setBusy('Approve "register" in your wallet (transaction 1 of 2)…')
      const h1 = await w.session.sendUpdate(toTx(start.transaction))
      setTxs([{ label: 'Agent minted (register)', hash: h1 }])
      setBusy('Waiting for the testnet…')
      const s1 = await waitForTx(h1)
      if (s1.reject) throw new Error(`The registry refused the registration (${s1.reject.name}).`)
      setBusy('Finding your new agent token…')
      let tokenId: number | null = null
      for (let i = 0; i < 10 && tokenId === null; i++) {
        const st = (await onChange()) as { data?: Status } | undefined
        const fresh = (st?.data?.agents ?? []).filter((a) => !before.has(a.token_id)).sort((a, b) => b.token_id - a.token_id)[0]
        if (fresh) tokenId = fresh.token_id
        else await sleep(4000)
      }
      if (tokenId === null) throw new Error('The new agent token is not visible yet. Reload in a minute; the next step continues from there.')
      await pinCard(tokenId)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  if (good) {
    return (
      <Card className="flex flex-col gap-2">
        <p className="text-po-ink">Agent <strong>#{good.token_id}</strong> on Concordium’s official agent registry &lt;12802,0&gt;, owned by your account. <StatusPill tone="ok">Verified by Concordium badge valid</StatusPill></p>
        {good.token_address ? <p className="text-sm text-po-grey">Badge <code>{good.token_address}</code></p> : null}
        {txs.map((t) => <TxLine key={t.hash} label={t.label} hash={t.hash} />)}
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-po-grey">Your invoices are issued by an AI-agent identity you own on Concordium’s official CIS-8004 registry. Two wallet approvals: mint the agent, then pin its card with the “Verified by Concordium” badge. About 40 test CCD in testnet fees.</p>
      {unbadged && !busy ? (
        <Card className="flex flex-col gap-2">
          <p className="text-po-ink">You already own agent #{unbadged.token_id}, but its badge is not valid yet.</p>
          <Button variant="primary" onClick={() => { setErr(null); pinCard(unbadged.token_id).catch((e) => setErr(errText(e))).finally(() => setBusy(null)) }}>Pin the badged card (1 approval)</Button>
        </Card>
      ) : null}
      {!unbadged ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void register() }}>
          <label className="flex flex-col gap-1 text-po-ink">Business or agent name
            <input className="po-input min-h-[44px] rounded-[10px] border border-po-line px-3" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Nour Design Studio" required minLength={2} />
          </label>
          <label className="flex flex-col gap-1 text-po-ink">What you sell, in one sentence
            <input className="po-input min-h-[44px] rounded-[10px] border border-po-line px-3" value={desc} maxLength={400} onChange={(e) => setDesc(e.target.value)} placeholder="Logo and brand design, invoiced per project." required minLength={10} />
          </label>
          <Button id="register-agent" type="submit" variant="primary" size="lg" busy={Boolean(busy)} disabled={name.trim().length < 2 || desc.trim().length < 10} disabledReason={name.trim().length < 2 || desc.trim().length < 10 ? 'Fill in both fields.' : null}>Register my seller agent</Button>
        </form>
      ) : null}
      {busy ? <Notice>{busy}</Notice> : null}
      {txs.map((t) => <TxLine key={t.hash} label={t.label} hash={t.hash} />)}
      {err ? <Notice tone="error">{err}</Notice> : null}
    </div>
  )
}

function ListStep({ account, agent, status, onChange }: { account: string; agent: Agent; status: Status; onChange: () => Promise<unknown> }) {
  const w = useWallet()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checks, setChecks] = useState<Array<{ id: string; label: string; status: string; detail: string }> | null>(null)
  if (status.listed && status.listing) {
    return (
      <Card className="flex flex-col gap-2">
        <p className="text-po-ink">Listed. PayOnce’s buyer wrote a vendor row for you on the registry: up to <strong>{status.listing.caps.per_payable_ccd} CCD</strong> per invoice and <strong>{status.listing.caps.period_ccd} CCD</strong> per day, enforced by the contract.</p>
        <TxLine label="Buyer’s approve_vendor" hash={status.listing.tx_hash} />
      </Card>
    )
  }
  async function list() {
    if (!w.session) return
    setErr(null); setChecks(null)
    try {
      setBusy('Getting a one-time listing message…')
      const ch = await walletApi<{ nonce: string; message: string }>('/api/open/sellers/challenge', { method: 'POST', body: { account, agent_token: agent.token_id } })
      setBusy('Sign the listing message in your wallet (no fee, nothing is sent)…')
      const signature = await w.session.signMessage(ch.message)
      setBusy('Checking your signature, agent and badge; the buyer writes your vendor row on chain…')
      const r = await walletApi<{ listed: boolean; checks: Array<{ id: string; label: string; status: string; detail: string }>; error?: string }>('/api/open/sellers/list', { method: 'POST', body: { account, agent_token: agent.token_id, nonce: ch.nonce, signature } })
      setChecks(r.checks)
      if (!r.listed) setErr(r.error ?? 'The listing was refused. See the checks.')
      await onChange()
    } catch (e) {
      setErr(errText(e))
    } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-po-grey">PayOnce’s buyer pays only sellers on its vendor list. Sign one message to prove you control this account; the buyer then lists you with small caps the contract enforces.</p>
      <Button id="list-seller" variant="primary" size="lg" busy={Boolean(busy)} onClick={() => void list()}>Sign and get listed</Button>
      {busy ? <Notice>{busy}</Notice> : null}
      {checks ? (
        <ul className="flex flex-col gap-1 text-sm">
          {checks.map((c) => <li key={c.id} className={c.status === 'ok' ? 'text-po-ok' : 'text-po-bad'}>{c.status === 'ok' ? '✓' : '✗'} {c.label} <span className="text-po-grey">({c.detail})</span></li>)}
        </ul>
      ) : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
    </div>
  )
}

function InvoiceStep({ account, status, onChange }: { account: string; status: Status; onChange: () => Promise<unknown> }) {
  const w = useWallet()
  const [amount, setAmount] = useState('0.5')
  const [desc, setDesc] = useState('')
  const [days, setDays] = useState(7)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  async function create() {
    if (!w.session) return
    setErr(null)
    try {
      setBusy('Writing the invoice document and its hash…')
      const d = await walletApi<{ invoice: OpenInvoice; transaction: ServerTx }>('/api/open/invoices/draft', { method: 'POST', body: { seller: account, amount_ccd: amount, description: desc, due_days: days } })
      setBusy('Approve "register_payable" in your wallet…')
      const h = await w.session.sendUpdate(toTx(d.transaction))
      setBusy('Waiting for the testnet…')
      const s = await waitForTx(h)
      if (s.reject) throw new Error(`The registry refused the invoice (${s.reject.name}).`)
      setBusy('Checking the on-chain row matches your draft…')
      let ok = false
      for (let i = 0; i < 6 && !ok; i++) {
        try { await walletApi('/api/open/invoices', { method: 'POST', body: { seller: account, payable_id: d.invoice.payable_id, tx_hash: h } }); ok = true } catch (e) { if (i === 5) throw e; await sleep(3000) }
      }
      setDesc('')
      await onChange()
    } catch (e) {
      setErr(errText(e))
    } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-po-grey">Your wallet registers the invoice on the PayOnce registry: amount, due date, the hash of the invoice text, your agent, and PayOnce’s buyer as the only payer. The payee is your own account.</p>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <label className="flex flex-col gap-1 text-po-ink">What is it for?
          <input className="po-input min-h-[44px] rounded-[10px] border border-po-line px-3" value={desc} maxLength={280} onChange={(e) => setDesc(e.target.value)} placeholder="Logo design, first round" required minLength={3} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-po-ink">Amount (test CCD, up to 1)
            <input className="po-input min-h-[44px] w-36 rounded-[10px] border border-po-line px-3" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-po-ink">Due in (days)
            <input className="po-input min-h-[44px] w-28 rounded-[10px] border border-po-line px-3" type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </label>
        </div>
        <Button id="create-invoice" type="submit" variant="primary" size="lg" busy={Boolean(busy)} disabled={desc.trim().length < 3} disabledReason={desc.trim().length < 3 ? 'Say what the invoice is for.' : null}>Register the invoice from my wallet</Button>
      </form>
      {busy ? <Notice>{busy}</Notice> : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      {status.invoices.length ? <p className="text-sm text-po-grey">{status.invoices.length} invoice{status.invoices.length > 1 ? 's' : ''} registered. The newest is in the next step.</p> : null}
    </div>
  )
}

function AgentPayStep({ invoice, onChange }: { invoice: OpenInvoice; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [out, setOut] = useState<{ paid: boolean; result?: { verdict?: string; reasons?: Array<{ code?: string; detail?: string }>; txs?: Array<{ step?: string; tx_hash?: string }> } } | null>(null)
  async function ask() {
    setBusy(true); setErr(null)
    try {
      const r = await walletApi<typeof out>(`/api/open/invoices/${invoice.seller}/${invoice.payable_id}/agent-pay`, { method: 'POST', body: {} })
      setOut(r)
      await onChange()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const paid = invoice.status === 'paid' || out?.paid
  const payTx = (out?.result?.txs ?? invoice.payment?.txs ?? []).find((t) => t.tx_hash)?.tx_hash
  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-1">
        <p className="text-po-ink">Invoice <strong>#{invoice.payable_id}</strong>: {invoice.description} — <strong>{invoice.amount_ccd} CCD</strong> to <Address value={invoice.payee} kind="account" label="payee" /></p>
        {invoice.register_tx ? <TxLine label="Registered from your wallet" hash={invoice.register_tx} /> : null}
      </Card>
      {paid ? (
        <Notice><strong>Paid by PayOnce’s agent.</strong> It read your invoice, checked the registry, your agent badge and its own vendor rules, then paid exactly once. {payTx ? <TxLine label="Agent’s payment" hash={payTx} /> : null}</Notice>
      ) : (
        <>
          <p className="text-po-grey">PayOnce’s buyer agent now reads your invoice as data (never as instructions), runs its checks and pays it from its own account.</p>
          <Button id="agent-pay" variant="primary" size="lg" busy={busy} onClick={() => void ask()}>Ask the agent to pay me</Button>
        </>
      )}
      {out && !out.paid ? <Notice tone="warn">The agent refused to pay{out.result?.verdict ? ` (${out.result.verdict})` : ''}. {(out.result?.reasons ?? []).map((r) => r.detail ?? r.code).filter(Boolean).join(' · ')}</Notice> : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      {paid ? <ButtonLink to={invoice.receipt_url} variant="secondary">Open the receipt</ButtonLink> : null}
    </div>
  )
}

function SellFlow() {
  const w = useWallet()
  const acct = w.session?.account ?? null
  const qc = useQueryClient()
  const info = useAccountInfo(acct)
  const st = useSellerStatus(acct)
  const refresh = useCallback(() => st.refetch(), [st])
  useEffect(() => { void qc.invalidateQueries({ queryKey: ['open-status'] }) }, [acct, qc])
  const status = st.data
  const bal = info.data?.balance_ccd != null ? Number(info.data.balance_ccd) : null
  const funded = bal !== null && bal >= SELL_MIN_CCD
  const agent = status?.agents.find((a) => a.badge_valid === true && (a.status ?? 'Active') === 'Active') ?? null
  const latest = status?.invoices[0] ?? null

  const s1: StepState = acct ? 'done' : 'active'
  const s2: StepState = !acct ? 'todo' : funded || agent ? 'done' : 'active'
  const s3: StepState = !acct || !status ? 'todo' : agent ? 'done' : funded ? 'active' : 'todo'
  const s4: StepState = !agent ? 'todo' : 'active'
  const s5: StepState = !agent ? 'todo' : status?.listed ? 'done' : 'active'
  const s6: StepState = !status?.listed ? 'todo' : latest ? 'done' : 'active'
  const s7: StepState = !latest ? 'todo' : latest.status === 'paid' ? 'done' : 'active'

  return (
    <ol className="ds-steps">
      <Step n={1} title="Connect your wallet" state={s1}><ConnectWallet purpose="register as a payee and get paid by an AI agent" /></Step>
      <Step n={2} title="Get test CCD" state={s2}>{acct ? <TestCcdHelper account={acct} minCcd={SELL_MIN_CCD} /> : null}</Step>
      <Step n={3} title="Register your seller agent" state={s3}>
        {st.isLoading ? <p className="text-po-grey">Reading the agent registry…</p> : null}
        {st.isError ? <Notice tone="error">{errText(st.error)}</Notice> : null}
        {acct && status ? <AgentStep account={acct} status={status} onChange={refresh} /> : null}
      </Step>
      <Step n={4} title="Prove the name on your invoices (Verification of Payee)" state={s4}>
        {acct && agent ? <PayeeProof account={acct} /> : null}
      </Step>
      <Step n={5} title="Get listed by PayOnce’s buyer" state={s5}>
        {acct && status && agent ? <ListStep account={acct} agent={agent} status={status} onChange={refresh} /> : null}
      </Step>
      <Step n={6} title="Register an invoice from your wallet" state={s6}>
        {acct && status?.listed ? <InvoiceStep account={acct} status={status} onChange={refresh} /> : null}
      </Step>
      <Step n={7} title="Let the agent pay you" state={s7}>
        {latest ? <AgentPayStep invoice={latest} onChange={refresh} /> : null}
      </Step>
    </ol>
  )
}

/** Testnet fees run several CCD per contract update; this flow sends about five. */
const SELL_MIN_CCD = 100

export function SellPage() {
  useDocumentTitle('Become a payee - PayOnce')
  return (
    <WalletProvider>
      <div className="ds ds-sell" data-testid="sell">
        <header className="ds-hero ds-hero--slim">
          <p className="ds-crumb"><Link to="/app">Run it</Link> · Become a payee</p>
          <h1 className="ds-h1">Get paid by an AI agent.</h1>
          <p className="ds-lead">Register from your own wallet, issue an invoice, watch the agent pay it once. Testnet fees are several test CCD per transaction (about 100 in all); Concordium’s faucet covers it.</p>
        </header>
        <div className="ds-body ds-body--wide">
          <SellFlow />
          <p className="ds-note ds-foot">Want to pay instead? <Link to="/app">Pay from your wallet</Link>.</p>
        </div>
      </div>
    </WalletProvider>
  )
}
