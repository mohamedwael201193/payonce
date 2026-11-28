// Fees in euros. Concordium prices energy (NRG) in euros on chain: `euroPerEnergy` = 1/50,000 EUR per NRG,
// the same on testnet and mainnet (GET /api/fees `rates`, read 28 Nov 2026; docs/FEES.md). Testnet CCD has no
// market value, so the euro figure is what the same energy costs on any Concordium network. Where only a CCD
// amount is known it is converted at the chain's own CCD/EUR oracle, about 430 CCD per EUR on 28 Nov 2026
// (testnet 432.4, mainnet 427.2); CoinGecko's market price that day, EUR 0.00233 per CCD, gives the same order.

export const EUR_PER_NRG = 1 / 50_000
export const CCD_PER_EUR = 430
export const FEE_RATE_DATE = '28 Nov 2026'

/** Measured NRG of sponsored calls (medians of finalized v3 transactions, docs/FEES.md). */
export const NRG = { pay_ccd: 2518, accept_payee: 1650, acknowledge_payee: 1585 } as const

/** "€0.05", "€0.003". Two decimals from one cent up, three below. Never "€0.00" for a non-zero fee. */
export function eur(v: number): string {
  if (v <= 0) return '€0'
  return v >= 0.01 ? `€${v.toFixed(2)}` : `€${v.toFixed(3)}`
}
export const eurOfNrg = (nrg: number): string => eur(nrg * EUR_PER_NRG)
export const eurOfCcd = (ccd: number): string => eur(ccd / CCD_PER_EUR)

/** One sentence, used wherever a paid invoice's fee is shown. */
export const PAID_INVOICE_FEE_TEXT = `about 20 CCD (${eurOfNrg(NRG.pay_ccd)})`

/** How the euro figure is made: shown under the fee in a "How is this computed?" disclosure. */
export const FEE_EUR_SOURCE =
  `Concordium prices energy in euros on chain (euroPerEnergy: 1 EUR per 50,000 NRG, the same price on every Concordium network). A payment uses about ${NRG.pay_ccd.toLocaleString('en-US')} NRG, so ${eurOfNrg(NRG.pay_ccd)}. ` +
  `At the chain's CCD/EUR rate of about ${CCD_PER_EUR} CCD per EUR (${FEE_RATE_DATE}), that is about 20 CCD. Testnet CCD has no market value; the euro figure is what the same energy costs on a Concordium network that uses real CCD. Source: GET /api/fees and docs/FEES.md.`
