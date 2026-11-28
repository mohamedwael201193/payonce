// The "your own wallet" payer for the Run-it flow, in the Run-it design language (rn-*).
// Desktop: Concordium Browser Wallet first, phone QR second. Phone: CryptoX over WalletConnect first (deep link).
// Then the balance, with one button for free test CCD. The wallet signs every payment; PayOnce never sees keys.
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '../../wallet/WalletContext'
import { useAccountInfo, BROWSER_WALLET_URL, MOBILE_WALLET_URL } from '../../wallet/WalletUI'
import { walletApi, WalletApiError } from '../../wallet/api'
import { cryptoxDeepLink } from '../../wallet/types'
import { midTruncate } from '../Address'

const EXPLORER = 'https://ccdexplorer.io/testnet/transaction/'
const EXPLORER_ACCOUNT = 'https://ccdexplorer.io/testnet/account/'
/** Enough for a 0.5 CCD invoice and the testnet fees of the payment (~21 CCD) and a refused second try (~6 CCD). */
export const MIN_CCD = 40

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    import('qrcode').then((q) => q.toDataURL(text, { margin: 1, width: 232, errorCorrectionLevel: 'M' })).then((d) => { if (alive) setSrc(d) }).catch(() => setSrc(null))
    return () => { alive = false }
  }, [text])
  return src
    ? <img className="rn-qr" src={src} width={232} height={232} alt="WalletConnect QR code. Scan it with CryptoX on your phone." />
    : <div className="rn-qr rn-qr--wait" aria-hidden />
}

/** Connect, or show the connected account. */
export function RunConnect() {
  const w = useWallet()
  if (w.status === 'checking') return <p className="rn-busy" role="status"><span className="rn-spin" aria-hidden />Looking for your wallet…</p>

  if (w.session) {
    const s = w.session
    return (
      <div className="rn-acct" data-testid="wallet-connected">
        <div>
          <p className="rn-note">{s.kind === 'browser' ? 'Concordium Browser Wallet' : 'Phone wallet (WalletConnect)'}</p>
          <a className="rn-a rn-mono" href={EXPLORER_ACCOUNT + s.account} target="_blank" rel="noreferrer" title={s.account}>{midTruncate(s.account, 6, 6)}</a>
        </div>
        <button className="rn-link" onClick={() => void w.disconnect()}>Disconnect</button>
        {s.chainOk === false && <p className="rn-failed rn-acct__warn">Your wallet is on another network. Switch it to <b>Testnet</b> in the wallet’s settings; PayOnce runs on testnet only.</p>}
      </div>
    )
  }

  const pairing = w.status === 'connecting' && w.pendingKind === 'walletconnect'
  const noExt = w.browserWallet === false
  const browserBtn = (
    <button key="bw" id="connect-browser" className={`rn-btn${w.mobile ? ' rn-btn--quiet' : ''}`} disabled={noExt} onClick={() => void w.connect('browser')}
      title={noExt ? (w.mobile ? 'Browser extensions do not run on phones. Use CryptoX.' : 'The extension is not installed in this browser.') : undefined}>
      {w.status === 'connecting' && w.pendingKind === 'browser' ? 'Approve in the extension…' : 'Concordium Browser Wallet'}
    </button>
  )
  const phoneBtn = (
    <button key="wc" id="connect-phone" className={`rn-btn${w.mobile ? '' : ' rn-btn--quiet'}`} onClick={() => void w.connect('walletconnect')}>
      {pairing && !w.pairingUri ? 'Opening…' : w.mobile ? 'Connect CryptoX' : 'Phone wallet (QR code)'}
    </button>
  )
  return (
    <div data-testid="wallet-connect">
      <div className="rn-actions">{w.mobile ? [phoneBtn, w.browserWallet ? browserBtn : null] : [browserBtn, phoneBtn]}</div>
      {noExt && !w.mobile && (
        <p className="rn-note">No extension in this browser? <a className="rn-a" href={BROWSER_WALLET_URL} target="_blank" rel="noreferrer">Install the Concordium Browser Wallet</a>, set it to Testnet, then reload. Or use your phone.</p>
      )}
      {pairing && w.pairingUri && (
        <div className="rn-pair" data-testid="wc-pairing">
          {w.mobile ? (
            <>
              <p className="rn-p">Open CryptoX, approve PayOnce, then come back to this tab.</p>
              <a className="rn-btn" href={cryptoxDeepLink(w.pairingUri)}>Open CryptoX</a>
              <p className="rn-note">Nothing happened? Install CryptoX and switch it to Testnet, or scan the code from another screen.</p>
            </>
          ) : (
            <>
              <p className="rn-p">Scan with CryptoX on your phone (Testnet), then approve PayOnce.</p>
              <Qr text={w.pairingUri} />
            </>
          )}
          <button className="rn-link" onClick={w.cancel}>Cancel</button>
        </div>
      )}
      {w.error && <div className="rn-failed" role="alert"><p>{w.error}</p></div>}
      <p className="rn-note">
        No wallet yet? <a className="rn-a" href={MOBILE_WALLET_URL} target="_blank" rel="noreferrer">CryptoX</a> on your phone or the{' '}
        <a className="rn-a" href={BROWSER_WALLET_URL} target="_blank" rel="noreferrer">Browser Wallet</a> for Chrome. Choose Testnet and create an identity with the
        Concordium testnet identity provider: it takes a minute and needs no documents.
      </p>
    </div>
  )
}

/** Balance and the free test CCD button. Returns whether the account can run the flow via `onReady`. */
export function RunFunds({ account }: { account: string }) {
  const info = useAccountInfo(account)
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ bad: boolean; text: React.ReactNode } | null>(null)
  const bal = info.data?.balance_ccd != null ? Number(info.data.balance_ccd) : null
  const enough = bal !== null && bal >= MIN_CCD

  async function ask() {
    setBusy(true); setMsg(null)
    try {
      const r = await walletApi<{ sent: boolean; tx_hash?: string; message?: string; source?: string; amount_ccd?: string }>('/api/wallet/faucet', { method: 'POST', body: { account } })
      if (r.sent && r.tx_hash) {
        setMsg({ bad: false, text: <>{r.source === 'concordium_faucet' ? 'Concordium’s testnet faucet is sending you test CCD.' : `PayOnce sent you ${r.amount_ccd} test CCD.`} It lands in about 10 seconds. <a className="rn-a" href={EXPLORER + r.tx_hash} target="_blank" rel="noreferrer">See the transfer</a></> })
        for (const ms of [6000, 12000, 20000]) window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['wallet-account', account] }), ms)
      } else setMsg({ bad: false, text: r.message ?? 'No test CCD was sent.' })
    } catch (e) {
      setMsg({ bad: true, text: e instanceof WalletApiError ? e.message : 'The request failed. Try again in a moment.' })
    } finally { setBusy(false) }
  }

  return (
    <div className="rn-funds" data-testid="test-ccd">
      <p className="rn-p">
        {info.isLoading ? 'Reading your balance…'
          : info.data?.exists === false ? 'This account is not on testnet yet. Finish creating it in your wallet, then come back.'
          : bal !== null ? <>Balance: <b>{info.data?.balance_ccd} CCD</b> <span className="rn-note">(test CCD, no real value)</span></>
          : 'Your balance is not available right now.'}
        {enough && <span className="rn-ok"> Enough for every step.</span>}
      </p>
      {!enough && info.data?.exists !== false && (
        <>
          <div className="rn-actions"><button id="get-test-ccd" className="rn-btn" disabled={busy} onClick={() => void ask()}>{busy ? 'Asking the faucet…' : 'Get free test CCD'}</button></div>
          <p className="rn-note">Or in your wallet: open the account’s <b>Activity</b> and tap <b>Request CCD</b>. Each new testnet account can ask once.</p>
        </>
      )}
      {msg && (msg.bad ? <div className="rn-failed" role="alert"><p>{msg.text}</p></div> : <p className="rn-note" role="status">{msg.text}</p>)}
    </div>
  )
}

export function useFunded(account: string | null | undefined): boolean {
  const info = useAccountInfo(account)
  const bal = info.data?.balance_ccd != null ? Number(info.data.balance_ccd) : null
  return bal !== null && bal >= MIN_CCD
}
