# PayOnce QA report — verification suite, first run

**QA agent, 2026-11-24 ~09:25 EET. Testnet only. No sends, no signing, no secrets.**
Work dir: `~/workspace/payonce-build/qa/`. This report is the record a
paired judge re-verifies: every green line has a command + full hash behind
it; everything else is NOT RUN and says why.

## 0. Headline
- **Baseline (v1, live on testnet): VERIFIED.** Contract `<13149,0>` exists,
  module hash exact match, balance 0, 7 methods. All 13 IDEA_V5 §5 txs
  finalized. 7 v1 reject codes verified FROM THE RECEIPTS (code + parameter),
  upgrading the parent judgment's 2 PARTIALs for the wrong-amount case.
- **F10 (critical verifier bug): CHAIN-EVIDENCE CONFIRMED.** The pay_ccd
  parameter carries the payable id on chain (tx 78377f18… param id 4;
  §5 pay_ccd param id 1) — so a verifier v2 CAN bind tx → payable id.
  The v1 verifier re-run itself is NOT RUN (verify-payable.mjs is not in
  this workspace).
- **v2 / E2E / attacks needing v2: ALL NOT RUN.** No v2 contract deployed
  (no deployer key — only the leaked seed, forbidden to use). No backend
  URL, no frontend URL, no MCP URL in config. E0–E12: 0/13 run.
- **Gate G0: 0 of 9 conditions met** (2 PARTIAL, 1 BLOCKED, 6 NOT MET).
  The public flip is BLOCKED on two user actions: delete + recreate the
  repo (old commits with DOB literals fetchable by SHA) and a new seed /
  deployer key.

## 1. Baseline verification (RUN — `node verify-chain.mjs`)
Output: `out/baseline-verify.json`. gRPC `grpc.testnet.concordium.com:20000`.

| Check | Result | Evidence |
|---|---|---|
| payable_registry v1 `<13149,0>` exists | PASS | module `9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24` (exact match), balance `0`, 7 methods (register_payable, pay_ccd, reserve_plt, confirm_plt, expire_reservation, get_payable, get_config), owner `42jaZZgd…` |
| Kinvoice baseline `<13148,0>` exists | PASS | module `2524566be043a51d…`, balance `0`, 4 methods |
| Official CIS-8004 `<12802,0>` exists | PASS | 22 methods (via contract agent's check-live.mjs, re-run read-only by QA from /tmp) |
| Official CIS-8 `<12801,0>` exists | PASS | 10 methods (same run) |
| All 13 §5 txs finalized | PASS | register `d8986836…`, pay_ccd `00e0ac1d…`, double-pay `a5ec5e40…`, wrong-amount `52f3b4aa…`, unknown-id `d906c0b3…`, reserve `ee56c0cc…`, co-signed EUDemo `7cc2f94f…`, 2nd-reserve `ae62175f…`, confirm `212f0ac7…`, reused-hash `02ad7347…`, stranger `8ee531f2…`, early-expiry `8902c4f1…`, 3rd-party-expiry `49260792…` (full hashes in out/baseline-verify.json) |
| pay_ccd forwards 500,000 microCCD in the same tx | PASS | tx `00e0ac1d…`: `Transferred` 500000 from `<13149,0>` to `4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin`; param id 1; cross-call `CIS-8004.agentOf` on `<13144,0>` (lab instance, NOT official `<12802,0>`) |
| Co-signed EUDemo has memo `payable:2` | PASS | tx `7cc2f94f…`: TokenTransfer EUDemo 10000 (0.01, 6 decimals) from `3cjnRyk51…` (2-of-3 agent account) to `4Vtd6WnC48…`, memo hex `6970617961626c653a32` = ASCII `payable:2` |
| confirm links the EUDemo tx | PASS | tx `212f0ac7…`: confirm_plt message = id 2 + `7cc2f94f…`; PltConfirmed event carries the same hash |

## 2. Attack suite (RUN — `node attack/attack-suite.mjs`)
Output: `out/attack.json`. **8 PASS, 1 CHAIN-EVIDENCE-RUN, 12 NOT RUN / 21.**

| ID | Attack | Result | Evidence |
|---|---|---|---|
| A-F10 | Present tx of payable 4 as proof for payable 1 | CHAIN-EVIDENCE-RUN | tx `78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e` finalized, pay_ccd param id **4**; §5 pay_ccd param id **1**. Binding data exists on chain → verifier v2 must check it. Verifier re-run NOT RUN (verify-payable.mjs absent from workspace — lab files never uploaded). |
| A5 | Wrong amount | PASS | tx `52f3b4aa…`: RejectedReceive pay_ccd **-6**, param id 4 |
| A6 | Double pay | PASS | tx `a5ec5e40…`: RejectedReceive pay_ccd **-5**, param id 1 |
| A7 | Unknown payable id (999) | PASS | tx `d906c0b3…`: RejectedReceive pay_ccd **-3**, param `e703000000000000` (999 LE) |
| A8 | Second reservation | PASS | tx `ae62175f…`: RejectedReceive reserve_plt **-16**, param id 2 |
| A9 | Reused tx hash confirm | PASS | tx `02ad7347…`: RejectedReceive confirm_plt **-12**, param id 3 + hash `7cc2f94f…` (the co-signed payment's own hash) |
| A10 | Stranger confirm | PASS | tx `8ee531f2…`: RejectedReceive confirm_plt **-17**, param id 3 + junk hash `8aca4f36…` |
| A11 | Early expiry confirm | PASS | tx `8902c4f1…`: RejectedReceive expire_reservation **-13**, param id 3 |
| A12 | Third-party expiry after window | PASS | tx `49260792…`: update succeeds, expire_reservation param id 3, no reject |
| A1 | H1: fraudster payable / vendor list | NOT RUN | needs v2 contract + vendor list |
| A2 | H2: junk confirm (seller must NOT ship) | NOT RUN | needs v2 (seller-names-payer + verifier-based recognition) |
| A3 | H2: stranger reserves, real payer pays | NOT RUN | needs v2 (expected_payer) |
| A4 | Race: confirm held past expiry, 2nd payment | NOT RUN | needs v2 + co-signer v2 (header-expiry bound) |
| A13 | F2 id-squatting | NOT RUN | needs v2 (key = seller, id) |
| A14 | Co-signer: wrong payee/amount/memo/token | NOT RUN | needs co-signer v2 decision table (C-19..C-25) |
| A15 | Co-signer: header expiry vs reservation expiry | NOT RUN | needs co-signer v2 (C-28..C-31) |
| A16 | Co-signer: approval revoked after reserve | NOT RUN | needs co-signer v2 (C-32) |
| A17 | Tampered doc_hash (one digit changed) | NOT RUN | needs verifier v2 |
| A18 | Void abuse (-26/-5/-25) | NOT RUN | needs v2 (X-01..X-06) |
| A19 | Cap abuse (-23) | NOT RUN | needs v2 (V-07, V-08) |
| A20 | Agent revoked after registration (-9) | NOT RUN | needs v2 (R2-06, F-02) |

**Correction to the parent judgment's PARTIALs:** the wrong-amount -6 mapping
is now VERIFIED from the receipt (RejectedReceive carries the code; the
label WRONG_AMOUNT is the plan §1.4 spec). The register PARTIAL stands:
the receipt shows the `agentOf` cross-call happened, but not its result
value — the Active/owner check is not visible in the receipt.

## 3. E2E 13-step script (plan P1 §6.4 — `node e2e/run-e2e.mjs`)
**0/13 PASS. All NOT RUN** — `v2_contract`, `backend_url`, `frontend_url`,
`mcp_url` are all null in `config.json`. Exit criterion (all steps green
TWICE in a row on fresh payables) is unmet. The runner is written and
precondition-checked; `--execute` refuses to fake a run (it reports NOT RUN
until the repo's live `e2e/run-e2e.mjs` implementation lands).

## 4. CI pipeline (plan P1 §6.5)
Deliverable written: `ci/github-actions.yml` (jobs: contracts — pinned Rust
1.85.0 + cargo-concordium 5.0.0, build wasm, `cargo test --release`,
clippy -D warnings, wasm sha256 artifact; js — Node 22, `npm ci`,
`node --test` co-signer + verifier fixtures, no network; secrets — scan
full history + tree; testnet e2e — manual-only, documented). **NOT RUN**
(no repo CI to run it against yet — the integration clone is not wired to
Actions; the paired judge runs it on the first push).

## 5. Secret scan (Gate G0 #7 support)
Tool written: `ci/secrets-scan.mjs` (seed/key/token/PEM/DOB patterns;
64-hex tx hashes allowlisted; `--history` scans full git history).
Self-tested: file with a known DOB → FAIL exit 1; clean file → CLEAN exit 0.
- QA dir: **CLEAN**. Repo clone current main (`ca90eac`): **CLEAN**
  (independent confirmation of the integration lead's gitleaks result).
- **Scanner bug found + fixed during this run:** (a) duplicate identifier
  `scanHistory` (const vs function) — crashed on load; (b) DOB pattern
  matched any YYYY-MM-DD, flagging a test timestamp comment
  (`// 2027-01-15, ms`) — narrowed to known DOB values + dob-keyword
  context, values built from parts so the script doesn't flag itself;
  (c) crashed on a file target (ENOTDIR) — fixed with a file branch.
- **Still BLOCKING G0 #7:** old commits `3fa8ca6`/`b681d5e` fetchable by
  SHA with DOB literals (integration lead). Repo must be deleted +
  recreated (user action) before any public flip.

## 6. Static checks on landed domain work (read-only; I did not modify or run their builds)
| Area | Finding | Severity |
|---|---|---|
| Frontend copy guard | `frontend/src/lib/copy.ts` implements BANNED_WORDS (13 banned claims with reasons) + honest copy ("Not verified…", "not yet (planned)", "Testnet only…"). BUT the enforcing vitest `tests/copy.test.ts` cited in the code comment **does not exist** (no `tests/` dir, no `*.test.*` files) — the guard is data, not an enforced test. | Medium — G0 #5/#6 enforcement gap |
| Frontend sample data | No hardcoded addresses/amounts in `frontend/src/` (grep). `dev:stub` script exists (dev-api-stub) — production build not inspected. | Info — G0 #8 unverified until a prod build is checked |
| Staging copy | `~/workspace/payonce-site-staging/src/lib/recorded.ts:34` hardcodes testnet account B's address (integration lead's flag, confirmed by reading) — must move to config, must NOT merge as-is. Staging is PAUSED awaiting the user's plain-words confirmation. | Medium — merge blocker |
| Backend tests | `backend/package.json`: `"test": "echo \"Error: no test specified\" && exit 1"` — no backend tests at all. Spikes S5–S6 output (`backend/spikes/s5-s6-output.json`) contains the raw pay_ccd tx JSON only; no recorded conclusion for S6 (which field carries block time). S5 (parameter encoding) is independently re-verified by QA (§1). | Medium — no backend test coverage; S6 answer unrecorded |
| Contract check-live script | `contract/scripts/check-live.mjs` prints `module=undefined` for every instance — it reads `info.moduleRef`, but SDK v12 returns `sourceModule` (with a `00000020` prefix). Balance + existence + method counts print correctly. QA re-ran it read-only from /tmp (not in the contract dir). | Low — diagnostic script bug; it cannot verify module hashes as written |
| Design artifacts | 20 frames, 3 webp assets (hero-sky, dawn-terrain, payonce-mark), tokens.css, index.html, dashboard.html present in `design/`. Not QA-verified (design judge's scope). | Info |
| Wallet (live, read-only) | `42jaZZgd…`: **144,734.90 CCD**, nonce **161**, EUDemo **30** (allowList true), observed 2026-11-24 ~09:14 EET. Last recorded: 145,423.21 CCD / nonce 151 (merge-round end 06:28). Delta **−688.31 CCD, +10 txs — cause NOT established from QA's evidence**; needs the ops log. | Info — open item for ops |

## 7. What is NOT verified (honest list)
- The 7 co-signer refusals, 26/26 Rust tests, verifier 10/10 + 12/12
  (claimed in IDEA_V5; PAYABLE_LOG.md + contract source never uploaded).
- Any v2 behaviour (contract, co-signer, verifier, MCP, backend, site).
- Any deployed URL (none exist). Any CI run (no Actions run yet).
- CCDScan deep-link URL format (all routes 404 via curl; homepage 200).
- The integration lead's gitleaks result (reported, not re-run by QA —
  gitleaks is not installed here; QA's own scanner confirms the current
  tree is clean).

## 8. Next QA runs (in order, as pieces land)
1. Contract agent: v2 built + unit tests (77 = 26+51) green → QA re-runs
   the Rust matrix from the plan §6.1 (read the test output, do not trust
   the count alone) + the co-signer 35-case table (§6.2) + verifier
   fixtures (§6.3, incl. `verify 1 <tx-of-4>` → FAIL after the F10 fix).
2. Deployer key (user/Claude) → v2 deployed → QA runs E0–E12 twice on
   fresh payables + the full attack suite live.
3. Backend/frontend deployed → QA runs the dashboard flow end-to-end in
   the browser + G0 #8 prod-build inspection + wording audit on the live
   site.
4. Freeze → independent judge verdict (G0 #9) → QA re-checks G0 #1–#9
   and the secret scan on the full history before any public flip.
