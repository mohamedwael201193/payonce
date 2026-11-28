// One wallet connection for the wallet pages: Concordium Wallet (browser extension) or CryptoX over WalletConnect.
// Resumes silently after a reload when the visitor already approved PayOnce.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isMobile, walletErrorText, type WalletKind, type WalletSession } from './types'

type Status = 'checking' | 'idle' | 'connecting' | 'connected'

interface WalletState {
  status: Status
  session: WalletSession | null
  /** WalletConnect pairing URI while a phone pairing is pending (QR on desktop, deep link on a phone). */
  pairingUri: string | null
  pendingKind: WalletKind | null
  error: string | null
  browserWallet: boolean | null
  mobile: boolean
  connect(kind: WalletKind): Promise<WalletSession | null>
  cancel(): void
  disconnect(): Promise<void>
}

const Ctx = createContext<WalletState | null>(null)
const LAST = 'payonce.wallet.kind'

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking')
  const [session, setSession] = useState<WalletSession | null>(null)
  const [pairingUri, setPairingUri] = useState<string | null>(null)
  const [pendingKind, setPendingKind] = useState<WalletKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browserWallet, setBrowserWallet] = useState<boolean | null>(null)
  const attempt = useRef(0)
  const mobile = useMemo(() => isMobile(), [])

  const gone = useCallback(() => {
    setSession(null)
    setStatus('idle')
    try { localStorage.removeItem(LAST) } catch { /* private mode */ }
  }, [])

  useEffect(() => {
    let alive = true
    let unwatch: () => void = () => {}
    ;(async () => {
      const bw = await import('./browser')
      const present = await bw.browserWalletPresent(mobile ? 400 : 1200)
      if (!alive) return
      setBrowserWallet(present)
      let last: string | null = null
      try { last = localStorage.getItem(LAST) } catch { /* ignore */ }
      let resumed: WalletSession | null = null
      if (last === 'browser' && present) resumed = await bw.resumeBrowserWallet()
      if (last === 'walletconnect') resumed = await (await import('./walletconnect')).resumeWalletConnect(gone)
      if (!alive) return
      if (resumed) { setSession(resumed); setStatus('connected') } else setStatus('idle')
      if (present) {
        unwatch = await bw.watchBrowserWallet(
          async (a) => {
            if (!a) return gone()
            const s = await bw.resumeBrowserWallet()
            if (s) setSession((cur) => (cur?.kind === 'browser' ? s : cur))
          },
          (ok) => setSession((cur) => (cur?.kind === 'browser' ? { ...cur, chainOk: ok } : cur)),
        )
      }
    })()
    return () => { alive = false; unwatch() }
  }, [gone, mobile])

  const connect = useCallback(async (kind: WalletKind) => {
    const my = ++attempt.current
    setError(null)
    setStatus('connecting')
    setPendingKind(kind)
    setPairingUri(null)
    try {
      const s = kind === 'browser'
        ? await (await import('./browser')).connectBrowserWallet()
        : await (await import('./walletconnect')).connectWalletConnect((uri) => { if (attempt.current === my) setPairingUri(uri) }, gone)
      if (attempt.current !== my) return null
      setSession(s)
      setStatus('connected')
      try { localStorage.setItem(LAST, kind) } catch { /* ignore */ }
      return s
    } catch (e) {
      if (attempt.current === my) {
        setError(walletErrorText(e))
        setStatus('idle')
      }
      return null
    } finally {
      if (attempt.current === my) { setPairingUri(null); setPendingKind(null) }
    }
  }, [gone])

  const cancel = useCallback(() => {
    attempt.current += 1
    setPairingUri(null)
    setPendingKind(null)
    setStatus(session ? 'connected' : 'idle')
  }, [session])

  const disconnect = useCallback(async () => {
    await session?.disconnect()
    gone()
  }, [session, gone])

  const value = useMemo<WalletState>(() => ({ status, session, pairingUri, pendingKind, error, browserWallet, mobile, connect, cancel, disconnect }),
    [status, session, pairingUri, pendingKind, error, browserWallet, mobile, connect, cancel, disconnect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet(): WalletState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
