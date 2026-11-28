# tools/census — Verification-of-Payee census + live claims checker

Read-only. No keys, no transactions. Python 3 stdlib + Node 20+ only.

| File | What |
| --- | --- |
| `census_public.json` | Page-ready summary (mainnet + testnet registry, live `check_payee` verdicts, x402 sellers). Re-generate with `python3 build_public.py` |
| `census_mainnet.csv`, `census_testnet.csv` | One row per registered agent: badge (official check), payee, identity provider, VoP pass |
| `vop_testnet_results.csv` | Live PayOnce `check_payee` verdict for every distinct testnet payee account (248) |
| `x402_sellers.json`, `x402_vop_results.csv` | Live x402 challenges (GET/POST, never paid) and `check_payee` on every Concordium `payTo` |
| `vop_mainnet_results.csv` | Live PayOnce `check_payee` (mainnet, identity-only mode) for every distinct mainnet payee account |
| `verify-sample.mjs` | Re-read a sample of accounts from a node and compare with the CSV (run from a machine with gRPC access) |
| `refresh.sh` | One refresh for the 6-hourly GitHub Action (`.github/workflows/census.yml`) |
| `check-live.mjs` | `node tools/census/check-live.mjs` → PASS/FAIL per public claim against live testnet (`--json` for machines) |
| `METHOD.md` | Method, limits (read before quoting a number) |
| `PLL_SPIKE.md` | Protocol-Level Locks spike verdict (NO-GO for a live demo, evidence) |
| `run_all.sh` | Reproduce everything (`dl_agents.py`, `fetch_cards.py`, `idp_scrape.py`, `census.py`, `vop_testnet.py`, `x402_probe.py`, `x402_vop.py`) |

Refreshed every 6 h by `.github/workflows/census.yml` (data committed to main). Served at `GET /api/census`. Read `METHOD.md` (exact wording, upper bound, definitions) before quoting any number.
