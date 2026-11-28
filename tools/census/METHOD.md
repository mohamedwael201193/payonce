# PayOnce — Verification-of-Payee census of the Concordium Agent Registry (read-only)

Run date: 28 Nov 2026 (Cairo). Read-only: no keys, no transactions, public data only.

## Question
How many registered agents would pass **Verification of Payee (VoP)** today, i.e. an agent that wants to pay them could
confirm *who the payee is* from chain data alone?

## Registries
- Mainnet CIS-8004 `<10082,0>` (CIS-8 `<10081,0>`); testnet CIS-8004 `<12802,0>` (CIS-8 `<12801,0>`).
  Source: hosted Agent Registry MCP `contract_info` (agent-registry-mcp.concordium.com).
- Enumeration: MCP `list_agents` (paginated, 500/page) — counts match indexer `/status` at run time (5,501 mainnet / 1,553 testnet).

## The VoP test (all must hold) — `vop_pass_today`
1. **Badge valid**: the official Concordium badge check (`/v1/check-badge/{token}`, the same engine as MCP `check_badge`)
   returns `badge_valid:true` (agent Active, card fetched, SHA-256 equals on-chain `metadata_hash`, badge well formed,
   token address/owner/contracts match, verification block present). Cheap local pre-filter first (Active + card HTTP 200 +
   hash equal + badge block present); agents failing the pre-filter are counted invalid without calling the official endpoint.
2. **Payee is bound on chain**: CIS-8004 `agentWallet` is set (the registry's payment-routing account). Unset = no verifiable payee.
3. **Payee has a business identity**: the payee account's credential was issued by the business ID provider
   (Global FinReg: mainnet idp 3, testnet idp 4) — read from CCDExplorer's account page (box cannot reach gRPC :20000).
   A person-ID account (Concordium testnet IP, Notabene, Digital Trust Solutions) cannot name a company, so it fails.
This is deliberately the *strict* reading (what PayOnce v3 requires before MATCH, minus the payee's signed binding to an
invoice identity which no other agent has). We also report the looser counts so the number can't be accused of cherry-picking.

## Other columns
- `card_mentions_x402` / `card_mentions_payment`: crude substring heuristics on the card JSON ("x402", "payment/invoice/checkout/price/ap2").
  Upper bounds, not proof of a working payment endpoint.
- `owner_idp`, `payee_idp`: identity provider names as shown by CCDExplorer.

## Limits (be honest in any claim)
- Business-ID check only proves the *account* belongs to a company identity; it does not check that the company's legal name
  equals the name on a given invoice (that is the part PayOnce adds). So "pass" here is an *upper bound* on real VoP matches.
- Testnet Global FinReg auto-approves anything, so testnet business IDs are weak evidence; mainnet is real KYB.
- Cards on unreachable hosts (timeouts) are counted as not fetched. Run is a snapshot; registry grows daily.
- Account→IdP resolution is by HTML scrape of ccdexplorer.io (1 req/s, polite UA). If it changes, use gRPC `getAccountInfo` credentials + `getIdentityProviders`.

## Reproduce
`./run_all.sh` (python3 stdlib only, ~30–60 min). Outputs `census_mainnet.csv`, `census_testnet.csv`, `summary.json`.
