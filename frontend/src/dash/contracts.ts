// API contracts for the /app dashboard (R0–R5) and /p/<account>.
// EXISTS = live on payonce-api today. PLANNED = WS1/WS3 implement exactly this shape
// (copied into payonce-private HANDOFF_V12). The UI treats a 404 from a PLANNED route
// as "not shipped yet" and says so; it never fakes a result.
import { walletApi, WalletApiError } from '../wallet/api'

export type Verdict = 'MATCH' | 'CLOSE_MATCH' | 'NO_MATCH' | 'UNVERIFIED'

/** EXISTS: GET /api/check-payee?seller=&payee=&legal_name= (alias of /api/vop/check). */
export interface CheckPayee {
  verdict: Verdict
  payable: boolean
  verified_name: string | null
  identity_kind: 'person' | 'business' | null
  standin: boolean
  reasons: string[]
  checks: { id: string; ok: boolean; detail: string }[]
  subject: { contract: string; seller: string; payee: string; invoice_name: string | null; book: { status: string }; proof_anchor: string | null }
  evidence_hash: string
  checked_at: string
}

/** EXISTS: GET /api/wallet/payee-proof/:account */
export interface PayeeProof {
  account: string
  kind: 'person' | 'business'
  name: string
  version: 'v1' | 'v0'
  vra_tx: string | null
  vaa_tx: string | null
  verified_at: string
  issuer: string | null
}

/** EXISTS: GET /api/relay/config */
export interface RelayConfig {
  sponsor: string
  contract: { index: string; subindex: string; name: string }
  entrypoints: string[]
  limits: { max_contract_energy: string; expiry_secs: [number, number]; per_sender_per_minute: number }
}

/** EXISTS: POST /api/relay/prepare { sender, entrypoint, parameter: hex, amount_micro_ccd? } -> sponsor-first transaction. */
export interface PreparedSponsored {
  mode: 'sponsor-first'
  transaction: unknown
  sender: string
  sponsor: string
  fee_paid_by: string
  expires_at: string
  schema: string | null
}

/** PLANNED (WS1): POST /api/payee/propose { account } -> the demo seller proposes the visitor as payee.
    The visitor then signs accept_payee { seller, version, proof_anchor } through /api/relay/prepare. */
export interface ProposedPayee {
  seller: string
  version: number
  /** hex, 32 bytes: sha256 of the stored name proof (see api/src/payee-proof.mjs) */
  proof_anchor: string
  tx_hash: string
}

/** PLANNED (WS1): GET /api/payee/:account -> the visitor's payee-book state on the demo book. */
export interface PayeeStatus {
  account: string
  seller: string
  status: 'NotBound' | 'Proposed' | 'Bound'
  version: number
  /** demo book: 90 s; production 24 h+, set at init */
  hold_secs: number
  hold_ends_at: string | null
  link: string
}

/** PLANNED (WS3): POST /api/invoices/parse { text } */
export interface ParsedInvoice {
  payee_name: string
  account: string
  amount_ccd: string
  reference: string | null
}

/** PLANNED (WS1): POST /api/getpaid { payee, invoice } -> { job_id }; GET /api/getpaid/:job -> GetPaidJob.
    The AP agent pays the visitor from the labelled reference payer after check_payee says MATCH. */
export type GetPaidStage = 'checking' | 'hold' | 'paying' | 'paid' | 'refused' | 'failed'
export interface GetPaidJob {
  job_id: string
  stage: GetPaidStage
  check: CheckPayee | null
  hold_ends_at: string | null
  pay_tx: string | null
  amount_display: string
  payer_label: string
  error: string | null
}

/** PLANNED (WS1): POST /api/getpaid/:job/redirect { to } -> the agent is told to pay another account. */
export interface RedirectResult {
  check: CheckPayee
  /** present when the agent was forced to submit and the chain refused (codes -28..-36) */
  refusal: { code: number; name: string; tx_hash: string } | null
}

/** EXISTS (WS3): GET /api/x402/sellers -> live x402 services run by other teams (Concordium testnet). */
export interface X402Seller {
  id: string
  name: string
  team: string
  url: string
  method: 'GET' | 'POST'
  price_ccd: string
  note: string
  body?: unknown
  /** PLANNED: set by WS3 when the service demands an 18+ proof. Absent today. */
  needs_age?: boolean
}
export interface X402SellersResponse {
  sellers: X402Seller[]
  policy: { network: string; max_ccd_per_purchase: string; asset: string; payer: string; outcomes: string[] }
}

export type Outcome = 'match' | 'close_match' | 'no_match' | 'not_possible'
export interface X402Decision {
  outcome: Outcome
  action: 'pay' | 'ask_human' | 'refuse'
  human_can_override: boolean
  why: string
}
/** EXISTS (WS3): POST /api/x402/probe { url, method, body?, name } -> free; never pays. */
export interface X402Probe {
  url: string
  name: string
  requires_payment: boolean
  selected?: { amount: string; amount_ccd: string; pay_to: string; network: string }
  pay_to?: string
  check: { verdict: Verdict; payable: boolean; verified_name: string | null; identity_kind: string | null; reasons: string[]; checks: { id: string; ok: boolean; detail: string }[]; evidence_hash: string | null } | null
  decision: X402Decision
}
/** EXISTS (WS3): POST /api/x402/buy { seller_id, name?, approved? } (3/h per IP). The reference buyer pays, not the visitor. */
export interface X402Buy extends X402Probe {
  paid: boolean
  tx_hash?: string | null
  explorer_url?: string | null
  delivered?: boolean
  http_status?: number
  response_preview?: string
  note?: string
}

/** EXISTS (WS3): GET /api/p/:account (the payee card) and GET /api/p/:account/check?name= */
export interface PayeeCard {
  account: string
  exists: boolean | null
  verified: boolean
  name: string | null
  kind: 'person' | 'business' | null
  proof: { version: string; verified_at: string; issuer: string | null; vra_tx: string | null; vaa_tx: string | null } | null
  bound: { status: string; seller?: string; hold_over?: boolean; version?: number } | null
  label: string
  testnet_note: string
  links: { page: string; check_payee: string; card_json: string; pay_with_wallet: string }
}

/** EXISTS (WS3): GET /api/census (tools/census/census_public.json + served{}). Wording rules: tools/census/METHOD.md. */
export interface CensusNet {
  agents_total: number
  active: number
  badge_valid_official: number
  agents_that_pass_vop_today: number
  pct_pass_vop_today: number
  valid_badge_but_payee_has_only_personal_identity_or_none: number
  payee_equals_owner_default: number
  payee_not_set: number
  owner_ne_payee: number
  distinct_owners: number
  distinct_owners_with_business_id: number
  cards_mentioning_x402_text: number
  owner_identity_provider_breakdown: Record<string, number>
}
export interface Census {
  schema: string
  generated_at_utc: string
  vop_rule: string
  networks: { mainnet: CensusNet; testnet: CensusNet }
  check_payee_live_on_testnet_payees: { accounts_checked: number; verdicts: Record<string, number>; note: string }
  x402_sellers: {
    concordium_endpoints_checked: number
    rows: { endpoint: string; network: string; payTo: string; amount: string; asset: string; check_payee_verdict: Verdict; payTo_business_id: boolean }[]
    payTo_with_business_identity: number
    endpoints_probed: number
    answering_402: number
    non_concordium_402_networks: Record<string, number>
  }
  served: { source: string; served_at: string; age_hours: number | null; stale: boolean; refresh: string }
}

/** PLANNED (WS1): wallet-signed 18+ proof for the visitor (V&A V1 in the wallet, V0 on phones).
    POST /api/wallet/age-proof/request { account, seller_id } -> { request_id, v1?, v0? }
    POST /api/wallet/age-proof/verify  { request_id, version, presentation } -> { verified, vaa_tx|null }.
    The existing /api/age-proof/v1 is a hosted check with one PayOnce testnet credential; it is not the visitor's proof. */
export interface AgeRequest { request_id: string; v1?: unknown; v0?: { challenge: string; statements: unknown } }
export interface AgeVerified { verified: boolean; vaa_tx: string | null }

/** PLANNED (WS1): GET /api/p/:account/pay-tx?payer=&amount_micro=[&approved=1] -> the exact pay transaction for the payer's wallet.
    Refuses NO_MATCH always. CLOSE_MATCH / UNVERIFIED only with approved=1 (the human decided; the contract's acknowledge_payee accepts CLOSE_MATCH,
    the agent itself pays only on MATCH). */
export interface PayLinkTx {
  transaction: import('../wallet/types').UpdateTx
  check: CheckPayee
}

/** PLANNED (WS1): GET /api/record/:account */
export interface RecordItem {
  at: string
  role: 'received' | 'paid' | 'refused'
  counterparty: string
  amount_display: string
  verdict: Verdict
  tx_hash: string
}

export class NotShipped extends Error {
  constructor(public route: string) { super(`${route} is not live yet.`) }
}

async function planned<T>(route: string, path: string, init?: Parameters<typeof walletApi>[1]): Promise<T> {
  try {
    return await walletApi<T>(path, init)
  } catch (e) {
    if (e instanceof WalletApiError && (e.status === 404 || e.code === 'not_found')) throw new NotShipped(route)
    throw e
  }
}

const q = encodeURIComponent

export const dashApi = {
  // EXISTS
  checkPayee: (seller: string, payee: string, name: string) =>
    walletApi<CheckPayee>(`/api/check-payee?seller=${q(seller)}&payee=${q(payee)}&legal_name=${q(name)}`),
  payeeProof: (account: string) => walletApi<{ account: string; proof: PayeeProof | null }>(`/api/wallet/payee-proof/${q(account)}`),
  relayConfig: () => walletApi<RelayConfig>('/api/relay/config'),
  prepare: (sender: string, entrypoint: string, parameterHex: string, amountMicro?: string) =>
    walletApi<PreparedSponsored>('/api/relay/prepare', { method: 'POST', body: { sender, entrypoint, parameter: parameterHex, ...(amountMicro ? { amount_micro_ccd: amountMicro } : {}) } }),
  // PLANNED
  propose: (account: string) => planned<ProposedPayee>('POST /api/payee/propose', '/api/payee/propose', { method: 'POST', body: { account } }),
  payeeStatus: (account: string) => planned<PayeeStatus>('GET /api/payee/:account', `/api/payee/${q(account)}`),
  parseInvoice: (text: string) => planned<ParsedInvoice>('POST /api/invoices/parse', '/api/invoices/parse', { method: 'POST', body: { text } }),
  startGetPaid: (payee: string, invoice: ParsedInvoice | null) =>
    planned<{ job_id: string }>('POST /api/getpaid', '/api/getpaid', { method: 'POST', body: { payee, invoice } }),
  getPaidJob: (job: string) => planned<GetPaidJob>('GET /api/getpaid/:job', `/api/getpaid/${q(job)}`),
  redirect: (job: string, to: string) =>
    planned<RedirectResult>('POST /api/getpaid/:job/redirect', `/api/getpaid/${q(job)}/redirect`, { method: 'POST', body: { to } }),
  // EXISTS (WS3)
  x402Sellers: () => walletApi<X402SellersResponse>('/api/x402/sellers'),
  x402Probe: (s: X402Seller) =>
    walletApi<X402Probe>('/api/x402/probe', { method: 'POST', body: { url: s.url, method: s.method, name: s.name, ...(s.method === 'POST' && s.body !== undefined ? { body: s.body } : {}) } }),
  x402Buy: (s: X402Seller, approved: boolean) =>
    walletApi<X402Buy>('/api/x402/buy', { method: 'POST', body: { seller_id: s.id, name: s.name, approved } }),
  payeeCard: (account: string) => walletApi<PayeeCard>(`/api/p/${q(account)}`),
  payeeCheck: (account: string, name: string) => walletApi<CheckPayee>(`/api/p/${q(account)}/check?name=${q(name)}`),
  census: () => walletApi<Census>('/api/census'),
  // PLANNED (WS1)
  ageRequest: (account: string, sellerId: string) =>
    planned<AgeRequest>('POST /api/wallet/age-proof/request', '/api/wallet/age-proof/request', { method: 'POST', body: { account, seller_id: sellerId } }),
  ageVerify: (requestId: string, version: string, presentation: string) =>
    planned<AgeVerified>('POST /api/wallet/age-proof/verify', '/api/wallet/age-proof/verify', { method: 'POST', body: { request_id: requestId, version, presentation } }),
  payLinkTx: (payee: string, payer: string, amountMicro: string, approved = false) =>
    planned<PayLinkTx>('GET /api/p/:account/pay-tx', `/api/p/${q(payee)}/pay-tx?payer=${q(payer)}&amount_micro=${q(amountMicro)}${approved ? '&approved=1' : ''}`),
  record: (account: string) => planned<{ items: RecordItem[] }>('GET /api/record/:account', `/api/record/${q(account)}`),
}

/** Bank wording for the four outcomes (EU VoP, Reg 2024/886). */
export const VERDICT_TEXT: Record<Verdict, { word: string; tone: 'ok' | 'warn' | 'bad'; agent: string }> = {
  MATCH: { word: 'Match', tone: 'ok', agent: 'Pays once' },
  CLOSE_MATCH: { word: 'Close match', tone: 'warn', agent: 'Asks you first' },
  NO_MATCH: { word: 'No match', tone: 'bad', agent: 'Pays nothing' },
  UNVERIFIED: { word: 'Not possible', tone: 'warn', agent: 'Asks you first' },
}
