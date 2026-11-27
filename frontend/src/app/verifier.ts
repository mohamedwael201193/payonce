// One generator for the keyless verifier command. The receipt, the pay flow
// and the judges page all print this exact form (the script in the repo is
// api/src/verify-payable-v2.mjs, run from api/). The shape depends on the
// payment: seller 2 needs --seller, and an EUDemo payment needs its reserve
// and confirm transactions too, or the verifier cannot check them
// (api/test/verify-command-shapes.test.mjs runs every shape).
export interface VerifierCommandInput {
  payableId: number
  /** The payment transaction: pay_ccd (CCD rail) or the EUDemo transfer. */
  txHash: string
  /** Relative path of the invoice text, to check the document hash too. */
  docPath?: string
  /** Seller address. Omitted for seller 1 (the CLI default). */
  seller?: string | null
  /** EUDemo rail: the reservation and confirm transactions. */
  reserveTx?: string | null
  confirmTx?: string | null
}

/** The API the printed commands read the invoice text from. */
export const PUBLIC_API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || 'https://payonce-api-n98a.onrender.com').replace(/[/]$/, '')

export const VERIFIER_SCRIPT = 'src/verify-payable-v2.mjs'

export function verifierCommand({ payableId, txHash, docPath, seller, reserveTx, confirmTx }: VerifierCommandInput): string {
  const parts = [`node ${VERIFIER_SCRIPT} ${payableId} ${txHash}`]
  if (seller) parts.push(`--seller ${seller}`)
  if (docPath) parts.push(`--doc ${docPath}`)
  if (reserveTx) parts.push(`--reserve ${reserveTx}`)
  if (confirmTx) parts.push(`--confirm ${confirmTx}`)
  return parts.join(' ')
}

/** The payment transaction of a receipt: the transfer or payment tx, else
    the first listed one. */
export function paymentTxOf(txs: Array<{ label: string; tx_hash: string }>): string {
  const pay = txs.find((t) => /^(transfer|payment)$/i.test(t.label)) ?? txs.find((t) => /transfer|payment|pay/i.test(t.label))
  return pay?.tx_hash ?? txs[0]?.tx_hash ?? ''
}

export interface ReceiptCommandInput {
  payableId: number
  seller: string
  /** The first seller's address: the CLI default, so it needs no --seller. */
  sellerOne: string | null | undefined
  txs: Array<{ label: string; tx_hash: string }>
  /** Base URL of the API, to fetch the registered invoice text. */
  apiBase: string
}

/** The exact commands a receipt prints. The document is fetched from the API
    (the registered LF text) so the run shows the same checks the page shows;
    without it the document row would be "not run". */
export function receiptCommands({ payableId, seller, sellerOne, txs, apiBase }: ReceiptCommandInput): string | null {
  const paymentTx = paymentTxOf(txs)
  if (!paymentTx) return null
  const leg = (re: RegExp) => txs.find((t) => re.test(t.label))?.tx_hash ?? null
  const isSellerOne = !sellerOne || seller === sellerOne
  const doc = `invoice-${isSellerOne ? '' : 's2-'}${payableId}.txt`
  const fetchDoc = `curl -s "${apiBase}/api/payables/${payableId}/document?seller=${seller}" -o ${doc}`
  const run = verifierCommand({
    payableId,
    txHash: paymentTx,
    seller: isSellerOne ? null : seller,
    docPath: doc,
    reserveTx: leg(/^reserv/i),
    confirmTx: leg(/^confirm/i),
  })
  return `${fetchDoc}\n${run}`
}
