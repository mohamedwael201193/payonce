// Recorded-run data — P3 §9 (refusals) and §14 (fees), from the lab run of
// 24 Nov 2026. These are NOT live API values: they are the published
// recorded run, and every surface that shows them labels them "Recorded run,
// 24 Nov 2026". No account addresses live here — only transaction hashes,
// reject codes and fee figures, all copied from PLAN_V5_PAYONCE_EXECUTION.md
// (§9 table lines ~1386–1400, §14 fees line ~1525, tx list lines ~1795–1796).
// The live API covers the same facts where it can: /api/stats returns
// refused_on_chain_since_deploy, /api/attacks/:kind returns the recorded
// refusal fee for the two chain attacks. When the backend exposes per-tx
// fees for all 7 refusals, this file should shrink to the fee ranges only.

export const RECORDED_DATE = '2026-11-24'

export interface RecordedRefusal {
  code: number
  name: string
  txHash: string
  plain: string
}

/** The 7 on-chain refusals of the recorded run (P3 §9). */
export const RECORDED_REFUSALS: RecordedRefusal[] = [
  {
    code: -5,
    name: 'WrongStatus',
    txHash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
    plain: 'This invoice is already paid, so the chain refused a second payment. Nothing moved.',
  },
  {
    code: -6,
    name: 'WrongAmount',
    txHash: '52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c',
    plain: 'The amount does not match the invoice. The chain refused it. Nothing was moved.',
  },
  {
    code: -3,
    name: 'NotFound',
    txHash: 'd906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28',
    plain: 'No invoice with this number is on the registry. Nothing was moved.',
  },
  {
    code: -16,
    name: 'AlreadyReservedOrPaid',
    txHash: 'ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35',
    plain: 'This invoice is already reserved or paid. The chain refused a second reservation before any money moved.',
  },
  {
    code: -12,
    name: 'TxReused',
    txHash: '02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b',
    plain: 'This payment transaction is already recorded against another invoice. Nothing was moved.',
  },
  {
    code: -17,
    name: 'NotPayerOrSeller',
    txHash: '8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a',
    plain: 'Only the payer or the seller can record this payment. The request was refused.',
  },
  {
    code: -13,
    name: 'NotExpired',
    txHash: '8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7',
    plain: 'The reservation is still open. It can be released only after its 300 s window.',
  },
]

export interface RecordedFeeBar {
  step: string
  /** Single measured value, or the low end of a measured range. */
  min: number
  /** High end of a measured range, or null for a single value. */
  max: number | null
  /** 'measured' = in the run log; 'not_measured' = no bar, shown as a gap. */
  state: 'measured' | 'not_measured'
  note: string
}

/**
 * Fees in the run (testnet CCD, from the log, not estimates — P3 §14).
 * Ranges are shown as range bars; the successful reserve has no measured
 * fee and is shown as "not measured", never a number.
 */
export const RECORDED_FEES: RecordedFeeBar[] = [
  { step: 'Register', min: 14.2, max: 14.7, state: 'measured', note: 'per invoice' },
  { step: 'Pay in CCD', min: 16.205, max: null, state: 'measured', note: 'success' },
  { step: 'Pay in CCD', min: 4.84, max: 4.93, state: 'measured', note: 'refused' },
  { step: 'Reserve refused', min: 4.98, max: null, state: 'measured', note: 'second payer' },
  { step: 'Confirm', min: 10.98, max: null, state: 'measured', note: 'on chain' },
  { step: 'EUDemo transfer', min: 7.07, max: null, state: 'measured', note: 'paid by the sponsor' },
  { step: 'Reserve', min: 0, max: null, state: 'not_measured', note: 'succeeded — fee not measured' },
]

/** The headline fee fact of the recorded run (P3 §14 / §16.13). */
export const FEE_HEADLINE =
  'A successful CCD payment cost 16.2 testnet CCD in the recorded run — more than the 0.5 CCD invoice. Fees vary per transaction. These are testnet fees, not mainnet estimates.'
