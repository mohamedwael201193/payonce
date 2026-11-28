# What a PayOnce payment costs (fee story, v3)

Live table: `GET /api/fees` (measured NRG x the chain's own exchange-rate parameters, refreshed hourly).

## The peg

Concordium prices energy (NRG) in euros on chain (`euroPerEnergy`) and converts to CCD with an oracle rate
(`microCCDPerEuro`). Read from both networks on 28 Nov 2026:

| network | EUR per NRG | CCD per EUR | CCD per NRG |
|---|---|---|---|
| mainnet | 1/50,000 = €0.00002 | ~400.2 | ~0.00800 |
| testnet | 1/50,000 = €0.00002 | ~399.9 | ~0.00800 |

Testnet and mainnet use the same EUR peg today, so the testnet costs below are what mainnet would charge.
Fees are charged on energy **used**, not on the max energy a transaction allows.

## Per step (medians of finalized v3 transactions, wallet-proxy, 28 Nov 2026)

| step | how often | who pays | NRG | CCD | EUR | example tx |
|---|---|---|---|---|---|---|
| propose_payee | once per payee binding | seller | 2,227 | 17.8 | €0.045 | a048180b… |
| accept_payee | once per binding, signed by the payee | PayOnce (sponsored) | 1,650 | 13.2 | €0.033 | af505045… |
| acknowledge_payee | once per buyer per payee version | PayOnce (sponsored) | 1,585 | 12.7 | €0.032 | 629bec43… |
| register_payable | per invoice | seller | 2,210 | 17.7 | €0.044 | c8a84777… |
| pay_ccd | per invoice paid (3 calls incl. CIS-8004 `agentOf`) | PayOnce (sponsored); the buyer sends only the invoice amount | 2,518 | 20.1 | €0.050 | 3882844c… |
| refused call that is sent (-29, -5, …) | per attempt | whoever sends it | 744 | 5.9 | €0.015 | 50f94790… |
| receipt-head anchor (registerData PVOH1, 45 bytes) | ≤ every 6 h, plus after a signed approval (max 12/day) | PayOnce | 508 | 4.1 | €0.010 | d7098429… |
| check_payee, dry runs, the attack catalogue | every check | nobody (node reads, InvokeInstance) | 0 | 0 | €0 | |

Full hashes are in `api/src/fees.mjs`.

## Totals

- **Per paid invoice: ~4,728 NRG ≈ €0.095** (register by the seller + sponsored payment). The buyer agent pays nothing but the invoice amount.
- **Per new payee: ~3,877 NRG ≈ €0.078**, once (propose + sponsored accept).
- **Per buyer per payee version: ~1,585 NRG ≈ €0.032**, once. Every later invoice to the same payee reuses the acknowledgment.
- **Receipt anchoring: ≤ €0.041/day.** One 45-byte head every 6 h covers every verdict receipt in between, so cost does not grow with checks.
- **An attack costs the attacker**, about €0.015 per refused transaction. Checking costs nobody anything.

## Energy cut without redeploying

v3 is deployed and verified; G20 says "redeploy nothing". These cuts are in place without touching the contract:

1. **Checks are free.** check_payee, the pay-tx preflight, and the 27-attack catalogue use node reads and
   InvokeInstance dry runs. A payment that would be refused is never sent, so no fee is spent on a predictable refusal.
2. **One acknowledgment per payee version**, not per invoice: the pay-tx route returns `acknowledge: null` when the buyer's
   acknowledgment is current.
3. **One invoice per payer, payee and amount** (`dash_paylink`): repeated pay links reuse it instead of registering again.
4. **Batched anchoring**: verdict receipts are hash-chained off chain and only the head is anchored (G16).
   The alternative, one registerData per receipt, costs €0.010 per check.
5. **Max energy is sized from the dry run** (+20% +500 NRG). This doesn't change the fee, but it keeps the sponsor's balance
   hold small and caps the cost of a surprise.

Candidate for a v3.1 module (not deployed; it would need a new verified deploy): `pay_ccd` makes a cross-contract
`agentOf` call on every payment. Caching the agent status in the registry would save that call, but a revoked agent
would keep paying until the cache refreshes. **That is a safety loss, so the call stays.**
