# tools/census — Verification-of-Payee census + live claims checker

Read-only. No keys, no transactions. Python 3 stdlib + Node 20+ only.

| File | What |
| --- | --- |
| `census_public.json` | Page-ready summary (mainnet + testnet registry, live `check_payee` verdicts, x402 sellers). Re-generate with `python3 build_public.py` |
| `census_mainnet.csv`, `census_testnet.csv` | One row per registered agent: badge (official check), payee, identity provider, VoP pass |
| `vop_testnet_results.csv` | Live PayOnce `check_payee` verdict for every distinct testnet payee account (248) |
| `x402_sellers.json`, `x402_vop_results.csv` | Live x402 challenges (GET/POST, never paid) and `check_payee` on every Concordium `payTo` |
| `check-live.mjs` | `node tools/census/check-live.mjs` → PASS/FAIL per public claim against live testnet (`--json` for machines) |
| `METHOD.md` | Method, limits (read before quoting a number) |
| `PLL_SPIKE.md` | Protocol-Level Locks spike verdict (NO-GO for a live demo, evidence) |
| `run_all.sh` | Reproduce everything (`dl_agents.py`, `fetch_cards.py`, `idp_scrape.py`, `census.py`, `vop_testnet.py`, `x402_probe.py`, `x402_vop.py`) |

Data snapshot: 28 Nov 2026. Re-run every 6 h with `run_all.sh` (the slow parts cache; `census.py` re-checks only new agents).
