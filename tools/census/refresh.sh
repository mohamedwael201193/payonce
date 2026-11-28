#!/usr/bin/env bash
# One census refresh (used by .github/workflows/census.yml every 6 h). Incremental by default (new agents/accounts only);
# on the first run of each UTC day (hour < 6) the badge and payee caches are dropped so every verdict is re-derived.
set -euo pipefail
cd "$(dirname "$0")"
if [ "$(date -u +%H)" -lt 6 ] || [ "${FULL:-0}" = "1" ]; then rm -f badge_official.json vop_testnet_cache.json vop_mainnet_cache.json; echo "full revalidation"; fi
rm -f vop_testnet_cache.json vop_mainnet_cache.json   # live verdicts are cheap (~250 + ~120 calls) and must be current
python3 dl_agents.py mainnet
python3 dl_agents.py testnet
python3 fetch_cards.py mainnet
python3 fetch_cards.py testnet
python3 idp_scrape.py
python3 census.py
python3 vop_testnet.py
python3 vop_mainnet.py
python3 x402_probe.py
python3 x402_vop.py
python3 build_public.py
