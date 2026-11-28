// Wallet-native PayOnce: the shapes every wallet path (Concordium Wallet in the browser, CryptoX over WalletConnect) shares.
// The server builds each transaction (contract, entrypoint, amount, JSON parameter, parameter schema); the wallet shows
// it decoded, the visitor approves, and the wallet signs and submits from the visitor's own account. No key ever
// reaches PayOnce.

export type WalletKind = 'browser' | 'walletconnect'

export interface UpdateTx {
  type?: 'Update'
  contract: { index: number; subindex: number }
  receive_name: string
  amount_micro: string
  parameter_json: unknown
  schema: { type: 'parameter'; value: string } | null
  max_energy: number
}

export type ProofResult = { version: 'v1' | 'v0'; presentation: string }

export interface WalletSession {
  kind: WalletKind
  account: string
  /** true on testnet, false on another chain, null when the wallet does not say. */
  chainOk: boolean | null
  sendUpdate(tx: UpdateTx): Promise<string>
  signMessage(text: string): Promise<unknown>
  /** V&A V1 when the wallet supports it, the V0 Web3 ID presentation otherwise. */
  requestProof(req: { v1?: unknown; v0?: { challenge: string; statements: unknown } }): Promise<ProofResult>
  disconnect(): Promise<void>
  /** Sponsor-first transaction from POST /api/relay/prepare: the wallet adds the sender signature and submits.
      Throws WalletTooOld when this wallet cannot (Concordium Wallet (browser) < 2.10, or a phone wallet without the method). */
  sendSponsored?(transaction: unknown, schemaBase64: string | null): Promise<string>
}

export class WalletTooOld extends Error {
  constructor() { super('This wallet cannot send sponsored transactions. Update to Concordium Wallet (browser) 2.10 or later, or use CryptoX on Android.') }
}

export const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796'

/** Plain-language message for a wallet error (user cancelled, locked, wrong network, ...). */
export function walletErrorText(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e ?? '')
  if (/rejected by the node|not accepted|invalid signature|signature/i.test(msg)) return 'The network refused to accept this transaction (it was never included, nothing was spent). If your account needs several signatures, use a single-key account.'
  if (/user rejected|rejected by user|reject|denied|cancel|declin|closed/i.test(msg)) return 'You cancelled in the wallet. Nothing was sent.'
  if (/locked/i.test(msg)) return 'Your wallet is locked. Unlock it and try again.'
  if (/not whitelist|not allowlist|not connected/i.test(msg)) return 'Concordium Wallet does not have this site on the allowlist for this account. Disconnect, then Connect again. If it still fails, remove this site from the wallet’s allowlist and connect once more.'
  if (/insufficient|not enough|amount too large|balance/i.test(msg)) return 'Your account does not have enough test CCD for this step. Get test CCD first.'
  if (/timeout|timed out/i.test(msg)) return 'The wallet did not answer in time. Open it and try again.'
  return msg ? `The wallet said: ${msg.slice(0, 200)}` : 'The wallet did not complete the request.'
}

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
}

/** Deep link that opens CryptoX (testnet build) with the pairing URI. */
export function cryptoxDeepLink(uri: string): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const enc = encodeURIComponent(uri)
  if (/android/i.test(ua)) return `cryptox-wc-testnet://wc?uri=${enc}&go_back=true`
  return `cryptoxtestnet://wc?uri=${enc}`
}
