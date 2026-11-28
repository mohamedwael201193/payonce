#!/usr/bin/env bash
# Reproduce the PayOnce Verification-of-Payee census end to end (read-only, public data, ~45-60 min).
# Needs python3 (stdlib only). No keys, no transactions.
set -euo pipefail
cd "$(dirname "$0")"
python3 dl_agents.py mainnet
python3 dl_agents.py testnet
python3 fetch_cards.py mainnet
python3 fetch_cards.py testnet
python3 idp_scrape.py
python3 census.py   # also runs the official Concordium badge check for every pre-filtered agent
python3 vop_testnet.py      # live check_payee on every testnet payee (paced <=20 req/min)
python3 x402_probe.py       # find live x402 sellers (card endpoints + x402_field_urls.txt), GET/POST only, no payment
python3 x402_vop.py
python3 vop_mainnet.py
python3 build_public.py
