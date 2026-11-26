// One generator for the keyless verifier command. The receipt, the pay flow
// and the judges page all print this exact form (the script that exists in
// the repo is api/src/verify-payable-v2.mjs). Run from api/.
export interface VerifierCommandInput {
  payableId: number
  txHash: string
  /** Relative path of the invoice text, to check the document hash too. */
  docPath?: string
}

export const VERIFIER_SCRIPT = 'src/verify-payable-v2.mjs'

export function verifierCommand({ payableId, txHash, docPath }: VerifierCommandInput): string {
  return `node ${VERIFIER_SCRIPT} ${payableId} ${txHash}${docPath ? ` --doc ${docPath}` : ''}`
}

/** The payment transaction of a receipt: the transfer or payment tx, else
    the first listed one. */
export function paymentTxOf(txs: Array<{ label: string; tx_hash: string }>): string {
  const pay = txs.find((t) => /transfer|payment|pay/i.test(t.label))
  return pay?.tx_hash ?? txs[0]?.tx_hash ?? ''
}
