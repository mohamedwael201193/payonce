// Shared wallet UI: connect (desktop extension first on a computer, CryptoX first on a phone), test-CCD helper,
// transaction progress. Plain words, one primary action per step.
import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, ExternalLink, Loader2, Smartphone, Monitor, XCircle } from 'lucide-react'
import { Address } from '../app/Address'
import { Button, ButtonRow, Card, Notice, StatusPill } from '../app/ui'
import { EXPLORER_TX } from '../lib/tokens'
import { useWallet } from './WalletContext'
import { walletApi, WalletApiError } from './api'
import { cryptoxDeepLink } from './types'

export const BROWSER_WALLET_URL = 'https://chromewebstore.google.com/detail/concordium-wallet/mnnkpffndmickbiakofclnpoiajlegmg'
export const MOBILE_WALLET_URL = 'https://www.concordium.com/wallets'

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    import('qrcode').then((q) => q.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' })).then((d) => { if (alive) setSrc(d) }).catch(() => setSrc(null))
    return () => { alive = false }
  }, [text])
  return src ? <img src={src} width={240} height={240} alt="WalletConnect QR code: scan it with CryptoX on your phone" className="rounded-[10px] border border-po-line bg-white p-2" /> : <div className="h-[240px] w-[240px] animate-pulse rounded-[10px] bg-po-surface" aria-hidden="true" />
}

/** Connect / connected card. `purpose` finishes the sentence "Connect your wallet to ...". */
export function ConnectWallet({ purpose }: { purpose: string }) {
  const w = useWallet()
  const [deepLink, setDeepLink] = useState<string | null>(null)
  useEffect(() => {
    if (!w.pairingUri) { setDeepLink(null); return }
    setDeepLink(cryptoxDeepLink(w.pairingUri))
  }, [w.pairingUri])

  if (w.status === 'checking') {
    return <Card><p className="flex items-center gap-2 text-po-grey"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Looking for your wallet…</p></Card>
  }

  if (w.session) {
    const s = w.session
    return (
      <Card className="flex flex-col gap-3" data-testid="wallet-connected">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-po-grey">{s.kind === 'browser' ? 'Concordium Browser Wallet' : 'Phone wallet (WalletConnect)'}</span>
            <Address value={s.account} kind="account" label="your account" />
          </div>
          <ButtonRow>
            <StatusPill tone={s.chainOk === false ? 'bad' : 'ok'}>{s.chainOk === false ? 'Wrong network' : 'Testnet'}</StatusPill>
            <Button small variant="ghost" onClick={() => void w.disconnect()}>Disconnect</Button>
          </ButtonRow>
        </div>
        {s.chainOk === false ? <Notice tone="warn">Your wallet is on another network. Switch it to <strong>Testnet</strong> in the wallet’s network settings; PayOnce runs on testnet only.</Notice> : null}
      </Card>
    )
  }

  const pairing = w.status === 'connecting' && w.pendingKind === 'walletconnect'
  const browserBtn = (
    <Button key="bw" id="connect-browser" variant={w.mobile ? 'secondary' : 'primary'} size="lg" busy={w.status === 'connecting' && w.pendingKind === 'browser'}
      disabled={w.browserWallet === false} disabledReason={w.browserWallet === false ? (w.mobile ? 'Browser extensions do not run on phones. Use CryptoX.' : 'The extension is not installed in this browser.') : null}
      onClick={() => void w.connect('browser')}>
      <Monitor className="h-4 w-4" aria-hidden="true" />Concordium Browser Wallet
    </Button>
  )
  const phoneBtn = (
    <Button key="wc" id="connect-phone" variant={w.mobile ? 'primary' : 'secondary'} size="lg" busy={pairing && !w.pairingUri} onClick={() => void w.connect('walletconnect')}>
      <Smartphone className="h-4 w-4" aria-hidden="true" />{w.mobile ? 'Connect CryptoX' : 'Phone wallet (QR code)'}
    </Button>
  )

  return (
    <Card className="flex flex-col gap-4" data-testid="wallet-connect">
      <div>
        <h2 className="text-xl font-semibold text-po-ink">Connect your wallet</h2>
        <p className="mt-1 max-w-[60ch] text-po-grey">Connect your own Concordium wallet to {purpose}. You approve every step in the wallet; PayOnce never sees your keys.</p>
      </div>
      <ButtonRow stack={w.mobile}>{w.mobile ? [phoneBtn, browserBtn] : [browserBtn, phoneBtn]}</ButtonRow>
      {w.browserWallet === false && !w.mobile ? (
        <p className="text-sm text-po-grey">No extension yet? <a className="underline" href={BROWSER_WALLET_URL} target="_blank" rel="noreferrer">Install the Concordium Browser Wallet<ExternalLink className="ml-1 inline h-3.5 w-3.5" aria-hidden="true" /></a>, create a testnet account, then reload this page.</p>
      ) : null}
      {pairing && w.pairingUri ? (
        <div className="flex flex-col items-start gap-3 rounded-[10px] border border-po-line p-4" data-testid="wc-pairing">
          {w.mobile ? (
            <>
              <p className="text-po-ink">Tap to open CryptoX and approve PayOnce. Then come back to this tab.</p>
              {deepLink ? <a href={deepLink} className="po-btn po-btn-primary po-btn-lg">Open CryptoX</a> : null}
              <p className="text-sm text-po-grey">CryptoX did not open? Make sure the app is installed and set to Testnet, or scan the code from another device.</p>
            </>
          ) : (
            <>
              <p className="text-po-ink">Scan with CryptoX on your phone (Testnet), then approve PayOnce.</p>
              <Qr text={w.pairingUri} />
            </>
          )}
          <Button small variant="ghost" onClick={w.cancel}>Cancel</Button>
        </div>
      ) : null}
      {w.error ? <Notice tone="error">{w.error}</Notice> : null}
      <p className="text-sm text-po-grey">No wallet yet? Get <a className="underline" href={MOBILE_WALLET_URL} target="_blank" rel="noreferrer">CryptoX for your phone</a> or the <a className="underline" href={BROWSER_WALLET_URL} target="_blank" rel="noreferrer">Browser Wallet for Chrome</a>, create a Testnet identity and account (the Concordium testnet identity provider needs no documents), then come back.</p>
    </Card>
  )
}

interface AccountInfo { account: string; exists: boolean; balance_ccd: string | null; needs_funds: boolean }

export function useAccountInfo(account: string | null | undefined) {
  return useQuery({
    queryKey: ['wallet-account', account],
    enabled: Boolean(account),
    refetchInterval: 15_000,
    queryFn: () => walletApi<AccountInfo>(`/api/wallet/account/${account}`),
  })
}

/** "Get test CCD": the balance, and one button that asks Concordium's testnet faucet (or PayOnce's starter drop). */
export function TestCcdHelper({ account, minCcd = 100 }: { account: string; minCcd?: number }) {
  const info = useAccountInfo(account)
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'error'; text: ReactNode } | null>(null)
  const bal = info.data?.balance_ccd != null ? Number(info.data.balance_ccd) : null
  const enough = bal !== null && bal >= minCcd

  async function ask() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await walletApi<{ sent: boolean; tx_hash?: string; message?: string; source?: string; amount_ccd?: string }>('/api/wallet/faucet', { method: 'POST', body: { account } })
      if (r.sent && r.tx_hash) {
        setMsg({ tone: 'info', text: <>{r.source === 'concordium_faucet' ? 'Concordium’s testnet faucet is sending test CCD.' : `PayOnce sent you ${r.amount_ccd} test CCD.`} It lands in about 10 seconds. <a className="underline" href={EXPLORER_TX + r.tx_hash} target="_blank" rel="noreferrer">See the transfer</a></> })
        window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['wallet-account', account] }), 8000)
      } else {
        setMsg({ tone: 'warn', text: r.message ?? 'No test CCD was sent.' })
      }
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof WalletApiError ? e.message : 'The request failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3" data-testid="test-ccd">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-po-ink">Test CCD</h2>
          <p className="text-po-grey">
            {info.isLoading ? 'Reading your balance…' : info.data?.exists === false ? 'This account is not on testnet yet. Finish creating it in your wallet.' : bal !== null ? <>Balance: <strong className="text-po-ink">{info.data?.balance_ccd} CCD</strong> (testnet, no real value)</> : 'Balance unavailable right now.'}
          </p>
        </div>
        {enough ? <StatusPill tone="ok">Enough for every step</StatusPill> : <StatusPill tone="warn">Needs test CCD</StatusPill>}
      </div>
      {!enough && !info.isLoading ? (
        <>
          <Button id="get-test-ccd" variant="primary" busy={busy} onClick={() => void ask()}>Get free test CCD</Button>
          <p className="text-sm text-po-grey">Or use the faucet in your wallet: open your account’s <strong>Activity</strong> and tap <strong>Request CCD</strong>. Each new testnet account can ask once.</p>
        </>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Card>
  )
}

export type StepState = 'todo' | 'active' | 'done' | 'failed'
export function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  const icon = state === 'done' ? <CheckCircle2 className="h-5 w-5 text-po-ok" aria-hidden="true" /> : state === 'failed' ? <XCircle className="h-5 w-5 text-po-bad" aria-hidden="true" /> : state === 'active' ? <Circle className="h-5 w-5 text-po-accent-ink" aria-hidden="true" /> : <Circle className="h-5 w-5 text-po-line-strong" aria-hidden="true" />
  return (
    <li className={`po-card flex flex-col gap-3 p-5 ${state === 'todo' ? 'opacity-70' : ''}`} aria-current={state === 'active' ? 'step' : undefined}>
      <div className="flex items-center gap-3">
        {icon}
        <h2 className="text-lg font-semibold text-po-ink"><span className="text-po-grey">{n}.</span> {title}</h2>
      </div>
      {state !== 'todo' && children ? <div className="flex flex-col gap-3">{children}</div> : null}
    </li>
  )
}

export function TxLine({ label, hash }: { label: string; hash: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-po-grey">
      {label}: <a className="font-mono text-po-accent-ink underline" href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">{hash.slice(0, 10)}…{hash.slice(-6)}</a>
    </p>
  )
}
