# PayOnce — Verification-of-Payee census of the Concordium Agent Registry (read-only)

First run: 28 Nov 2026 (Cairo); re-run every 6 h by GitHub Actions. Read-only: no keys, no transactions, public data only.

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

## Exact wording (copy these; the numbers come from `census_public.json`, field `wording`)
- SAY: "At most N of M registered agents meet the *preconditions* of a Verification-of-Payee check today." (**upper bound**, snapshot at `generated_at_utc`).
- DO NOT SAY: "N agents are verified / safe / legitimate", "M-N agents are fraudulent", "no Concordium agent can be trusted".
- "Pass" = valid badge (registry's own check) AND agentWallet set AND the payee account holds a business identity (Global FinReg). It is an upper bound because a real
  MATCH additionally needs the legal name proven or payee-signed (PayOnce v3 payee book, testnet) and equal to the invoice name. Nobody outside PayOnce has that today.
- "Payee" = `agentWallet`, or the owner when none is set (registry semantics). The registry defaults `agentWallet` to the owner on registration, so
  `payee_equals_owner_default` is mostly the default and is **not** evidence that a developer chose to separate a payee.
- `distinct_owners` counts accounts, not people or companies: one company can hold many accounts.
- Population: tokens returned by `list_agents` for each network at run time (mainnet 5,501 / testnet 1,553 on 28 Nov 2026). It is not "all Concordium agents".
- Scope of "x402 sellers": Concordium-network `accepts` entries found in live 402 challenges of endpoints reachable from agent cards or `x402_field_urls.txt` (GET/POST, never paid).
  It is a lower bound on live sellers (cards that do not advertise the endpoint are missed) and a handful, so quote counts, not percentages.
- Testnet business IDs are weak evidence (the testnet Global FinReg issuer auto-approves). Mainnet business IDs are real KYB; mainnet figures are the ones to headline.

## Limits
- A business identity proves the *account* belongs to *a* company; it does not say which, so it never proves the invoice name. That part is PayOnce's.
- Account→provider attribution is a scrape of CCDExplorer's public account page (1 req/s, polite UA); the live `check_payee` reads a node (gRPC `getAccountInfo`) instead.
  If the page layout changes, the run fails the sanity check in `.github/workflows/census.yml` instead of publishing wrong numbers. **Sample verification:** see below.
- Cards on unreachable hosts (timeouts, circuit breaker after 6 failures per host) count as "card not fetched", hence badge not valid. A transient outage can lower the badge count for one run.
- Snapshot: the registry grows daily; every figure carries its `generated_at_utc` and `/api/census` adds `served.age_hours` and `served.stale`.
- Mainnet `check_payee` is identity-only (`mode: identity_only`): never MATCH, never `payable`, because the payee book (v3) exists on testnet only.

## Sample verification (how the scrape is cross-checked against a node)
`node tools/census/verify-sample.mjs` (needs `cd api && npm ci` and a reachable Concordium gRPC node, e.g. momo's PC; the census host blocks port 20000).
It re-reads `getAccountInfo` for every business-identity account plus a seeded random sample (default 25/network), compares the identity-provider set with the CSV and prints the
agreement rate; exit code 1 on any mismatch. The mainnet `check_payee` also reads the node directly on every call (fallback to the explorer is labelled `source: ccdexplorer`).
Until it has been run from a machine with gRPC, state the identity data as "read from CCDExplorer", not "verified on-chain".

## Refresh
`.github/workflows/census.yml` runs `refresh.sh` every 6 hours (cron `17 */6 * * *`), sanity-checks, and commits `tools/census` as mohamedwael201193 with `[skip render]`.
The first run of each UTC day drops the badge cache and re-derives every badge. `GET /api/census` serves the committed `census_public.json` (raw GitHub, 10 min cache, bundled fallback).

## Reproduce
`./run_all.sh` or `./refresh.sh` (python3 stdlib only, ~30–60 min). Outputs `census_*.csv`, `summary.json`, `census_public.json`.
