// API contracts for the /app dashboard (R0–R5) and /p/<account>.
// EXISTS = live on payonce-api today. PLANNED = WS1/WS3 implement exactly this shape
// (copied into payonce-private HANDOFF_V12). The UI treats a 404 from a PLANNED route
// as "not shipped yet" and says so; it never fakes a result.
// WS1 (payonce-private HANDOFF_V14): every WS1 route below except age-proof is LIVE on the v3 DEMO book <13173,0>
// (90 s hold). Changes are optional fields only, except: checkPayee and prepare send book=demo (the dashboard's
// payees live on the demo book), payLinkTx can pass the invoice name, and PayLinkTx.acknowledge, when not null,
// must be signed (sponsored, via prepare) before the payment, or the chain refuses -30 PayeeNotAcknowledged.
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

/** LIVE (WS1): POST /api/payee/propose { account } -> the demo seller proposes the visitor as payee.
    The visitor then signs accept_payee { seller, version, proof_anchor } through /api/relay/prepare. */
export interface ProposedPayee {
  seller: string
  version: number
  /** hex, 32 bytes: sha256 of the stored name proof (see api/src/payee-proof.mjs) */
  proof_anchor: string
  /** null only when the record existed before this server stored the proposal */
  tx_hash: string | null
  /** 'Bound' = accept_payee already signed: skip it. Errors: 409 no_name_proof | would_reject, 429 rate_limited. */
  status?: 'Proposed' | 'Bound'
  book?: string
}

/** LIVE (WS1): GET /api/payee/:account -> the visitor's payee-book state on the demo book. */
export interface PayeeStatus {
  account: string
  seller: string
  status: 'NotBound' | 'Proposed' | 'Bound'
  version: number
  /** demo book: 90 s; production 24 h+, set at init */
  hold_secs: number
  hold_ends_at: string | null
  link: string
  book?: string
  proof_anchor?: string | null
}

/** PLANNED (WS3): POST /api/invoices/parse { text } */
export interface ParsedInvoice {
  payee_name: string
  account: string
  amount_ccd: string
  reference: string | null
}

/** LIVE (WS1): POST /api/getpaid { payee, invoice } -> { job_id }; GET /api/getpaid/:job -> GetPaidJob.
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
  // optional extras (WS1)
  payee?: string
  invoice_name?: string
  payable_id?: number | null
  txs?: { ack: string | null; register: string | null; pay: string | null }
  /** set when the chain refused the payment itself (-28..-36) */
  refusal?: { code: number; name: string; tx_hash: string } | null
}

/** LIVE (WS1): POST /api/getpaid/:job/redirect { to } -> the agent is told to pay another account. */
export interface RedirectResult {
  check: CheckPayee
  /** present when the agent was forced to submit and the chain refused (codes -28..-36) */
  refusal: { code: number; name: string; tx_hash: string } | null
  /** one sentence on what happened, e.g. "Forced anyway, the chain refused: PayeeNotBound (-28)." */
  note?: string
  to?: string
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
  check_payee_live_on_mainnet_payees?: { mode: string; accounts_checked: number; verdicts: Record<string, number>; note: string; payable?: number; accounts_with_business_identity?: number }
  x402_sellers: {
    concordium_endpoints_checked: number
    rows: { endpoint: string; network: string; payTo: string; amount: string; asset: string; check_payee_verdict: Verdict; payTo_business_id: boolean }[]
    payTo_with_business_identity: number
    endpoints_probed: number
    answering_402: number
    non_concordium_402_networks: Record<string, number>
    unverified_means?: string
  }
  wording?: { x402_sellers_wording?: string; sample_verification?: string; headline?: string; upper_bound?: string }
  served: { source: string; served_at: string; age_hours: number | null; stale: boolean; refresh: string }
}

/** PLANNED (WS1): wallet-signed 18+ proof for the visitor (V&A V1 in the wallet, V0 on phones).
    POST /api/wallet/age-proof/request { account, seller_id } -> { request_id, v1?, v0? }
    POST /api/wallet/age-proof/verify  { request_id, version, presentation } -> { verified, vaa_tx|null }.
    The existing /api/age-proof/v1 is a hosted check with one PayOnce testnet credential; it is not the visitor's proof. */
export interface AgeRequest { request_id: string; v1?: unknown; v0?: { challenge: string; statements: unknown } }
export interface AgeVerified { verified: boolean; vaa_tx: string | null }

/** LIVE (WS1): GET /api/p/:account/pay-tx?payer=&amount_micro=[&name=][&approved=1] -> the exact pay transaction for the payer's wallet.
    Refuses NO_MATCH always. CLOSE_MATCH / UNVERIFIED only with approved=1 (the human decided; the contract's acknowledge_payee accepts CLOSE_MATCH,
    the agent itself pays only on MATCH). WS1: UNVERIFIED is refused even with approved=1 (409 not_payable): the contract
    cannot record an acknowledgment for it, so the payment would be refused -36. CLOSE_MATCH without approved=1 -> 409 needs_approval. */
export interface PayLinkTx {
  rail: 'ccd' | 'eudemo'
  /** CCD rail only: the wallet Update (pay_ccd) the visitor signs. */
  transaction?: import('../wallet/types').UpdateTx
  check: CheckPayee
  /** not null = the payer has not acknowledged this payee version yet: first
      dashApi.prepare(payer, 'acknowledge_payee', acknowledge.parameter) + sendSponsored (PayOnce pays the fee). */
  acknowledge: { entrypoint: 'acknowledge_payee'; parameter: string; book: 'demo' } | null
  invoice: { seller: string; payable_id: number; amount_micro: string; asset?: string; register_tx: string; book: string; memo?: string }
  /** EUDemo rail: reserve_plt (sponsored) before the token transfer. */
  reserve?: { entrypoint: 'reserve_plt'; parameter: string; book: 'demo' }
  /** EUDemo rail: one sponsored EUDemo transfer; the relayer co-signs only to this payable’s bound payee, for this amount, while Reserved. */
  transfer?: { kind: 'token'; token: 'EUDemo'; recipient: string; amount: string; memo: string; book: 'demo'; rule?: string }
  confirm?: { entrypoint: 'confirm_plt'; how: string }
  replay?: { entrypoint: 'reserve_plt'; parameter: string; expect_reject: number; expect_name: string }
  approval?: { approval_id: string; approval_hash: string } | null
}

export interface PltConfirm {
  entrypoint: 'confirm_plt'
  parameter: string
  book: 'demo'
  invoice: { seller: string; payable_id: number; book: string }
}

export interface PreparedSponsoredToken {
  transaction: unknown
  schema: null
  sender: string
}

/** LIVE (WS1): GET /api/record/:account */
export interface RecordItem {
  at: string
  role: 'received' | 'paid' | 'refused'
  counterparty: string
  amount_display: string
  verdict: Verdict
  /** null when nothing reached the chain (the agent refused before sending) */
  tx_hash: string | null
  note?: string
}

/** LIVE (WS1, G11): POST /api/approvals/request -> sign `message` with the wallet:
    Browser Wallet provider.signMessage(payer, message) (returns {credIndex: {keyIndex: hex}}); WalletConnect sign_message. */
export interface ApprovalRequest {
  approval_id: string
  message: string
  expires_at: string
  verdict: Verdict
  evidence_hash: string
  invoice_hash: string
  check: CheckPayee
}
/** LIVE (WS1, G11): POST /api/approvals/:id/verify { signature } and GET /api/approvals/:id */
export interface Approval {
  approval_id: string
  state: 'requested' | 'approved'
  approved: boolean
  payer: string
  payee: string
  name: string
  amount_micro: string
  verdict: Verdict
  evidence_hash: string
  invoice_hash: string
  message: string
  signature: unknown | null
  approval_hash: string | null
  approved_at: string | null
  /** position in the hash-chained receipt ledger (GET /api/vop/ledger) */
  ledger: { seq: number; entry_hash: string; prev_hash: string } | null
  /** the ledger head anchor sent after the approval (registerData PVOH1), or why it was deferred */
  anchor: { seq: number | null; tx_hash: string | null; state: string | null; skipped: string | null } | null
  expires_at: string
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
    walletApi<CheckPayee>(`/api/check-payee?book=demo&seller=${q(seller)}&payee=${q(payee)}&legal_name=${q(name)}`),
  payeeProof: (account: string) => walletApi<{ account: string; proof: PayeeProof | null }>(`/api/wallet/payee-proof/${q(account)}`),
  relayConfig: () => walletApi<RelayConfig>('/api/relay/config'),
  prepare: (sender: string, entrypoint: string, parameterHex: string, amountMicro?: string) =>
    walletApi<PreparedSponsored>('/api/relay/prepare', { method: 'POST', body: { sender, entrypoint, parameter: parameterHex, book: 'demo', ...(amountMicro ? { amount_micro_ccd: amountMicro } : {}) } }),
  // LIVE (WS1, demo book)
  propose: (account: string) =>
    walletApi<ProposedPayee>('/api/payee/propose', { method: 'POST', body: { account } }),
  payeeStatus: (account: string) => walletApi<PayeeStatus>(`/api/payee/${q(account)}`),
  parseInvoice: (text: string) => planned<ParsedInvoice>('POST /api/invoices/parse', '/api/invoices/parse', { method: 'POST', body: { text } }),
  startGetPaid: (payee: string, invoice: ParsedInvoice | null) =>
    walletApi<{ job_id: string }>('/api/getpaid', { method: 'POST', body: { payee, invoice } }),
  getPaidJob: (job: string) => walletApi<GetPaidJob>(`/api/getpaid/${q(job)}`),
  redirect: (job: string, to: string) =>
    walletApi<RedirectResult>(`/api/getpaid/${q(job)}/redirect`, { method: 'POST', body: { to } }),
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
  /** CLOSE_MATCH needs approvalId (approvalRequest -> wallet signMessage -> approvalVerify). approved=true alone is
      answered 409 needs_signed_approval (WS1 G11: a click is not evidence). */
  payLinkTx: (payee: string, payer: string, amountMicro: string, approved = false, name?: string, approvalId?: string | null, rail: 'ccd' | 'eudemo' = 'ccd') =>
    walletApi<PayLinkTx>(`/api/p/${q(payee)}/pay-tx?payer=${q(payer)}&amount_micro=${q(amountMicro)}&asset=${rail}${approved ? '&approved=1' : ''}${name ? `&name=${q(name)}` : ''}${approvalId ? `&approval=${q(approvalId)}` : ''}`),
  prepareToken: (sender: string, transfer: { recipient: string; amount: string; memo: string }) =>
    walletApi<PreparedSponsored>('/api/relay/prepare', { method: 'POST', body: { sender, kind: 'token', recipient: transfer.recipient, amount: transfer.amount, memo: transfer.memo, book: 'demo' } }),
  pltConfirm: (payee: string, payableId: number, txHash: string) =>
    walletApi<PltConfirm>(`/api/p/${q(payee)}/plt-confirm`, { method: 'POST', body: { payable_id: payableId, tx_hash: txHash } }),
  // LIVE (WS1, G11): the person's wallet signs the approval message; the server verifies it against the account keys on chain.
  approvalRequest: (payer: string, payee: string, name: string, amountMicro: string) =>
    walletApi<ApprovalRequest>('/api/approvals/request', { method: 'POST', body: { payer, payee, name, amount_micro: amountMicro } }),
  approvalVerify: (id: string, signature: unknown) =>
    walletApi<Approval>(`/api/approvals/${q(id)}/verify`, { method: 'POST', body: { signature } }),
  approval: (id: string) => walletApi<Approval>(`/api/approvals/${q(id)}`),
  record: (account: string) => walletApi<{ items: RecordItem[] }>(`/api/record/${q(account)}`),
}

/** Bank wording for the four outcomes (EU VoP, Reg 2024/886). */
export const VERDICT_TEXT: Record<Verdict, { word: string; tone: 'ok' | 'warn' | 'bad'; agent: string }> = {
  MATCH: { word: 'Match', tone: 'ok', agent: 'Pays once' },
  CLOSE_MATCH: { word: 'Close match', tone: 'warn', agent: 'Asks you first' },
  NO_MATCH: { word: 'No match', tone: 'bad', agent: 'Pays nothing' },
  UNVERIFIED: { word: 'Not possible', tone: 'warn', agent: 'Asks you first' },
}
