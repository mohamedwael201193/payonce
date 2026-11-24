# PayOnce click-test log

PASS  hero loads with live stats — 5 | payables on the registry | 3 | paid | 7 | refused on chain | 10:42 UTC | last verifier run
PASS  compact hero ≤ 220px tall (F10f) — 202px
PASS  steps 1–3 fit at 1440×900 (pay bottom ≤ 900) — pay bottom 876px, invoice top 257px
PASS  no horizontal overflow at 1440 — scrollWidth 1440 vs innerWidth 1440
PASS  skip link is first Tab stop
PASS  skip link jumps to #invoice — invoice top after jump: 16px
PASS  Unpaid tab shows 3 and 5, hides paid 1 — Payable 3
0.01 EUDemo
Unpaid
Due in 20h 52m
Receipt | Payable 5
0.01 EUDemo
Unpaid
Due in 20h 52m
Receipt
PASS  Refused tab lists 7 recorded refusals
PASS  gauge shows 60% (3 of 5 paid once)
PASS  fees chart shows recorded run + not measured
PASS  lab invoice 3 loads with chain facts — Payable 3 — 0.01 EUDemo
PASS  fingerprint shown first-8 + last-6
PASS  9 checks run, verdict ready — verdict: All checks passed
PASS  Pay in EUDemo enabled after ready check
PASS  pay shows honest stub 503, no crash — The stub never sends a transaction
PASS  payable 3: honest "no recorded run" (not a fake run)
PASS  payable 2: recorded run shows real steps (check_wallet…verify)
PASS  pay twice refused by chain (-5) with fee
PASS  wrong amount refused by chain (-6) with fee
PASS  unlisted seller refused by this app (no tx)
PASS  tamper detected (hash mismatch, pay blocked)
PASS  injection ignored (payee is the account on chain)
PASS  receipt 2: paid once, verifier 12/12
PASS  receipt re-verify works (Check again on chain)
PASS  glossary uses "reserved", never "held"
PASS  judges page renders (verifier, limits, build status)
PASS  receipt checker reaches stage 4 (Paid once: yes)
PASS  receipt checker replay restarts stages
PASS  zero page errors — none
PASS  zero unexpected console errors — none
PASS  no unexpected failed responses (pay 503 + recorded/3 404 are expected) — only the expected ones
PASS  no horizontal overflow at 390 — scrollWidth 390 vs innerWidth 390
PASS  sticky bottom bar visible on mobile with disabled reason
PASS  sticky bar becomes Pay in EUDemo (0.01 EUDemo) after check

Console errors: Failed to load resource: the server responded with a status of 503 (Service Unavailable) | Failed to load resource: the server responded with a status of 404 (Not Found)
Page errors: none
Failed responses: 503 http://localhost:5173/api/payables/3/pay | 404 http://localhost:5173/api/recorded/3

Result: ALL PASS
