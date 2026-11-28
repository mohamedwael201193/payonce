// CryptoX / Concordium mobile wallet over WalletConnect v2. Loaded on demand with the wallet pages.
// Desktop: a QR code to scan with the phone. Phone: an "Open CryptoX" deep link (iOS and Android schemes differ).
// Transactions go through the official @concordium/wallet-connectors serializer (WalletConnectConnection), so the
// wallet receives exactly the payload format it expects.
import {
  CONCORDIUM_WALLET_CONNECT_PROJECT_ID, TESTNET, WalletConnectConnection, WalletConnectConnector, getChainId,
  moduleSchemaFromBase64, stringMessage, typeSchemaFromBase64, type WalletConnectionDelegate,
} from '@concordium/wallet-connectors'
import {
  AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, Energy, ReceiveName, Transaction,
} from '@concordium/web-sdk'
import { WalletTooOld, type ProofResult, type UpdateTx, type WalletSession } from './types'

const PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || CONCORDIUM_WALLET_CONNECT_PROJECT_ID
const CHAIN_ID = getChainId(TESTNET)
const REQUIRED = { methods: ['sign_and_send_transaction', 'sign_message'], chains: [CHAIN_ID], events: ['accounts_changed', 'chain_changed'] }
const OPTIONAL = { methods: ['request_verifiable_presentation', 'request_verifiable_presentation_v1', 'sign_and_send_sponsored_transaction'], chains: [CHAIN_ID], events: [] as string[] }

let connectorPromise: Promise<WalletConnectConnector> | null = null
let onGone: (() => void) | null = null

const delegate: WalletConnectionDelegate = {
  onAccountChanged: () => {},
  onChainChanged: () => {},
  onConnected: () => {},
  onDisconnected: () => onGone?.(),
}

function connector(): Promise<WalletConnectConnector> {
  if (!connectorPromise) {
    connectorPromise = WalletConnectConnector.create(
      {
        projectId: PROJECT_ID,
        metadata: {
          name: 'PayOnce',
          description: 'Pay an invoice exactly once, from your own Concordium wallet (testnet).',
          url: typeof window !== 'undefined' ? window.location.origin : 'https://payonce.vercel.app',
          icons: [typeof window !== 'undefined' ? `${window.location.origin}/favicon.svg` : ''],
        },
      },
      delegate,
      TESTNET,
    ).catch((e) => {
      connectorPromise = null
      throw e
    })
  }
  return connectorPromise
}

export { cryptoxDeepLink } from './types'

function wrap(conn: WalletConnectConnection): WalletSession {
  const account = conn.getConnectedAccount()
  const request = <T,>(method: string, params: unknown) =>
    conn.connector.client.request<T>({ topic: conn.session.topic, chainId: conn.chainId, request: { method, params } })
  return {
    kind: 'walletconnect',
    account,
    chainOk: true, // the session is bound to ccd:testnet
    async sendUpdate(tx: UpdateTx) {
      return conn.signAndSendTransaction(
        account,
        AccountTransactionType.Update,
        {
          amount: CcdAmount.fromMicroCcd(BigInt(tx.amount_micro)),
          address: ContractAddress.create(tx.contract.index, tx.contract.subindex),
          receiveName: ReceiveName.fromString(tx.receive_name),
          maxContractExecutionEnergy: Energy.create(tx.max_energy),
        },
        tx.schema ? { parameters: tx.parameter_json as never, schema: typeSchemaFromBase64(tx.schema.value) } : undefined,
      )
    },
    async sendSponsored(transaction: unknown, schemaBase64: string | null) {
      const methods = conn.session.namespaces.ccd?.methods ?? []
      if (!methods.includes('sign_and_send_sponsored_transaction')) throw new WalletTooOld()
      return conn.signAndSendSponsoredTransaction(
        AccountAddress.fromBase58(account),
        Transaction.signableFromJSON(transaction),
        schemaBase64 ? moduleSchemaFromBase64(schemaBase64) : undefined,
      )
    },
    async signMessage(text: string) {
      return conn.signMessage(account, stringMessage(text))
    },
    async requestProof(req): Promise<ProofResult> {
      const methods = conn.session.namespaces.ccd?.methods ?? []
      if (req.v1 && methods.includes('request_verifiable_presentation_v1')) {
        const out = await request<unknown>('request_verifiable_presentation_v1', req.v1)
        return { version: 'v1', presentation: typeof out === 'string' ? out : JSON.stringify(out) }
      }
      if (req.v0) {
        const out = await request<{ verifiablePresentationJson: string }>('request_verifiable_presentation', {
          paramsJson: JSON.stringify({ challenge: req.v0.challenge, credentialStatements: req.v0.statements }),
        })
        return { version: 'v0', presentation: out.verifiablePresentationJson }
      }
      throw new Error('The connected wallet does not offer the requested proof.')
    },
    async disconnect() {
      await conn.disconnect().catch(() => {})
    },
  }
}

/** Reuse a WalletConnect session this browser already approved (survives reloads). */
export async function resumeWalletConnect(onDisconnected: () => void): Promise<WalletSession | null> {
  try {
    const c = await connector()
    onGone = onDisconnected
    const sessions = c.client.session.getAll().filter((s) => s.namespaces.ccd?.accounts?.some((a) => a.startsWith(`${CHAIN_ID}:`)))
    const s = sessions[sessions.length - 1]
    return s ? wrap(new WalletConnectConnection(c, CHAIN_ID, s)) : null
  } catch {
    return null
  }
}

/**
 * Start a pairing. `onUri` receives the WalletConnect URI right away (render a QR code on desktop, an
 * "Open CryptoX" button on a phone). Resolves when the visitor approves in the wallet.
 */
export async function connectWalletConnect(onUri: (uri: string) => void, onDisconnected: () => void): Promise<WalletSession> {
  const c = await connector()
  onGone = onDisconnected
  const { uri, approval } = await c.client.connect({ requiredNamespaces: { ccd: REQUIRED }, optionalNamespaces: { ccd: OPTIONAL } })
  if (uri) onUri(uri)
  const session = await approval()
  return wrap(new WalletConnectConnection(c, CHAIN_ID, session))
}
