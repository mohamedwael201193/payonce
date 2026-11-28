// Concordium Wallet (browser extension, Chrome Web Store id mnnkpffndmickbiakofclnpoiajlegmg) path. Loaded on demand with the wallet pages.
import { detectConcordiumProvider } from '@concordium/browser-wallet-api-helpers'
import {
  AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, Energy, ReceiveName, Transaction, VerificationRequestV1,
} from '@concordium/web-sdk'
import { TESTNET_GENESIS, WalletTooOld, type ProofResult, type UpdateTx, type WalletSession } from './types'

type Api = Awaited<ReturnType<typeof detectConcordiumProvider>>

export async function browserWalletPresent(timeoutMs = 1200): Promise<boolean> {
  try {
    await detectConcordiumProvider(timeoutMs)
    return true
  } catch {
    return false
  }
}

function session(api: Api, account: string, chainOk: boolean | null): WalletSession {
  return {
    kind: 'browser',
    account,
    chainOk,
    async sendUpdate(tx: UpdateTx) {
      return api.sendTransaction(
        AccountAddress.fromBase58(account),
        AccountTransactionType.Update,
        {
          amount: CcdAmount.fromMicroCcd(BigInt(tx.amount_micro)),
          address: ContractAddress.create(tx.contract.index, tx.contract.subindex),
          receiveName: ReceiveName.fromString(tx.receive_name),
          maxContractExecutionEnergy: Energy.create(tx.max_energy),
        },
        tx.parameter_json as never,
        tx.schema ? { type: 'parameter', value: tx.schema.value } : undefined,
      )
    },
    async sendSponsored(transaction: unknown, schemaBase64: string | null) {
      const send = (api as { sendSponsoredTransaction?: unknown }).sendSponsoredTransaction
      if (typeof send !== 'function') throw new WalletTooOld()
      return (api.sendSponsoredTransaction as (a: unknown, t: unknown, s?: unknown) => Promise<string>)(
        AccountAddress.fromBase58(account),
        Transaction.signableFromJSON(transaction),
        schemaBase64 ? { type: 'ModuleSchema', value: schemaBase64 } : undefined,
      )
    },
    async signMessage(text: string) {
      return api.signMessage(AccountAddress.fromBase58(account), text)
    },
    async requestProof(req): Promise<ProofResult> {
      if (req.v1 && typeof (api as { requestVerifiablePresentationV1?: unknown }).requestVerifiablePresentationV1 === 'function') {
        const pres = await api.requestVerifiablePresentationV1(VerificationRequestV1.fromJSON(req.v1 as never))
        return { version: 'v1', presentation: JSON.stringify((pres as { toJSON?: () => unknown }).toJSON?.() ?? pres) }
      }
      if (req.v0) {
        const pres = await api.requestVerifiablePresentation(req.v0.challenge, req.v0.statements as never)
        return { version: 'v0', presentation: pres.toString() }
      }
      throw new Error('This wallet version cannot create the requested proof.')
    },
    async disconnect() {
      /* the extension keeps its own allowlist; nothing to tear down here */
    },
  }
}

/** Ask the extension for an account. Throws a readable error when it is missing or the visitor declines. */
export async function connectBrowserWallet(): Promise<WalletSession> {
  let api: Api
  try {
    api = await detectConcordiumProvider(2500)
  } catch {
    throw new Error('The Concordium Wallet extension was not found in this browser.')
  }
  const accounts = await api.requestAccounts()
  const account = (await api.getMostRecentlySelectedAccount()) ?? accounts[0]
  if (!account) throw new Error('The wallet returned no account. Create or select an account in the extension.')
  const genesis = await api.getSelectedChain().catch(() => undefined)
  return session(api, account, genesis ? genesis === TESTNET_GENESIS : null)
}

/** Reconnect silently when the visitor already approved this site (no popup). */
export async function resumeBrowserWallet(): Promise<WalletSession | null> {
  try {
    const api = await detectConcordiumProvider(800)
    const account = await api.getMostRecentlySelectedAccount()
    if (!account) return null
    const genesis = await api.getSelectedChain().catch(() => undefined)
    return session(api, account, genesis ? genesis === TESTNET_GENESIS : null)
  } catch {
    return null
  }
}

/** Account / chain change notifications from the extension. */
export async function watchBrowserWallet(onAccount: (a: string | null) => void, onChain: (ok: boolean) => void): Promise<() => void> {
  try {
    const api = await detectConcordiumProvider(800)
    const acc = (a: string) => onAccount(a)
    const dis = () => onAccount(null)
    const chain = (g: string) => onChain(g === TESTNET_GENESIS)
    api.on('accountChanged', acc)
    api.on('accountDisconnected', dis)
    api.on('chainChanged', chain)
    return () => {
      api.removeListener?.('accountChanged', acc)
      api.removeListener?.('accountDisconnected', dis)
      api.removeListener?.('chainChanged', chain)
    }
  } catch {
    return () => {}
  }
}
