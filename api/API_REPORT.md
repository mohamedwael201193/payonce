# PayOnce API server — API_REPORT.md

**Status: BUILT + TESTED LIVE. All 16 P3 endpoints implemented. Unit 10/10, live read-only integration 16/16, full smoke E2E PASSED (fresh CCD + EUDemo pays, live attacks).**

Work dir: `~/workspace/payonce-build/api/` · Server: `src/server.mjs` (Node built-in `http` only, no framework) · Default: `http://127.0.0.1:7401` (the port the frontend's dev stub used — the frontend + its 34-check click-test run unchanged) · Registry: v2 `<13150,0>` (`payable_registry_v2`, module `c8083a94…`), switchable to the v2.1 instance by config. Testnet only.

## 1. Endpoints (all 16 P3 §16 + SSE + download)

| # | Endpoint | What it returns (live) |
|---|---|---|
| 1 | `GET /api/config` | Registry `<13150,0>` + module ref; CIS-8004 `<12802,0>` (official, module `0e574737…`); `reservation_secs` 3600 (read live from `get_config`); vendor list (read live — exactly the owner); build flags (`vendor_list_enforced_by_co_signer: true`, `named_payer_on_invoice: true`, `confirm_by: 'payer (the reserving payer)'`, `header_expiry_bound: true`); limits (3 new invoices/hour, 10 attempts/min/IP); verifier `verify-payable-v2.mjs` (2026-11-24) |
| 2 | `GET /api/health` | Chain reachable (live consensus read); payer/sponsor CCD status (live balances — `ok` ≥ 50 CCD, see §5); EUDemo wallet status (live token balance); co-signer `ok`; per-IP budget (new invoices + attack sends left this hour) |
| 3 | `GET /api/stats` | `payables_total`, `paid_total` (live scan of known ids); `refused_on_chain_since_deploy` (distinct rejected txs in the evidence files + live refusals this server observed — see §6); `last_verifier_run_at` (this server's counter) |
| 4 | `GET /api/invoices` | Unpaid + recent Paid payables, live rows: id, asset, amount display, due, status, label |
| 5 | `GET /api/payables/:id` | Live facts: asset, amount, payee, seller, due, `is_past_due` (chain time), status (unpaid/reserved/paid), agent (registry `<12802,0>`, token), `doc_sha256` (the on-chain hash). Paid: `payment_tx` + source (`chain` for EUDemo — confirm records it; `server_store` for CCD — v2 does not record it, F5) |
| 6 | `GET /api/payables/:id/document` | The exact registered document bytes (text). 404 for any id without a lab document (P3 §16.5) |
| 7 | `POST /api/payables/:id/verify` | `{mode, doc_sha256?}` → before_pay 9 checks / after_pay 10 (CCD) or 12 (EUDemo) checks, verdict `ready`/`blocked`/`paid`, `passed`/`total`, `blocked_reason`, `read_ms` |
| 8 | `POST /api/payables` | Creates a fresh payable: generates the lab invoice, hashes it, registers it (owner sends), returns `{payable_id, tx_hash, explorer_url, fee_testnet_ccd, due}`. Rate-limited 3/hour/IP. Fresh ids start at 1000; due = now + 24 h; CCD 0.5 to payee1, EUDemo 0.01 to payee2, `expected_payer` = demo payer B, agent token 1476 |
| 9 | `POST /api/payables/:id/pay` | Creates (or returns the existing running) job; runs the pay flow async; returns `{job_id, payable_id, rail, steps: string[]}`. Refuses before any send: unknown id (404), wrong rail (409 `wrong_asset`), doc mismatch (409 `doc_mismatch`), already Paid (409 `already_paid`), Reserved (409 `reserved_by_other`), Voided (409 `wrong_status`) |
| 10 | `GET /api/jobs/:id` | Job snapshot: state (`running`/`succeeded`/`refused`/`failed`), steps with status/detail/txHash/explorerUrl/layer/reject, outcome, timestamps |
| 11 | `GET /api/jobs/:id/events` | SSE: `{type:'step', step}` per step, `{type:'done', outcome, receipt_url}` at the end; the current snapshot on connect; heartbeat re-checks a finished job so `done` is never lost on reconnect |
| 12 | `GET /api/tx/:hash/status` | Live `getBlockItemStatus`: `{tx_hash, status, reject, fee_testnet_ccd, explorer_url}`. Unknown hash → 404 |
| 13 | `POST /api/cosigner/dry-run` | `{payable_id, to, amount, memo}` (memo as text or CBOR hex) → live snapshot + `decide()` → `{decision, reason, plain, tx_sent: false}`. Nothing is ever sent |
| 14 | `POST /api/attacks/:kind` | `pay_twice` / `wrong_amount` / `unlisted_seller` — live where possible, recorded otherwise (§4) |
| 15 | `GET /api/receipts/:id` (also `/api/payables/:id/receipt`) | Receipt rebuilt live from the chain + a fresh verifier re-run (10 CCD / 12+2 EUDemo). Unpaid → 404 |
| 16 | `GET /api/recorded/:id` | Recorded run from the backend evidence files (labelled "Recorded run, 24 Nov 2026") |
| 17 | `GET /api/judges/files` (+ `GET /api/judges/files/:name`) | List + download. Only files that exist, SHA-256 computed at startup from the actual bytes |

Errors use the P3 §16.1 envelope under an `error` key: `{code, layer, message, retryable, reject?, fee_testnet_ccd?, tx_hash?, explorer_url?, retry_after_s?}`. Rate limit → 429 `rate_limited` (retryable, `retry_after_s`). Chain down → 503 `chain_unreachable` (retryable). Refused txs still cost a fee — the fee is shown on the refusal.

## 2. How each endpoint maps to the backend modules

The backend modules are imported from the merged backend (resolved by `src/backend.mjs`: `PAYONCE_BACKEND_DIR` → repo `backend/` → work-tree `payonce-build/backend/`). Only pure functions and read helpers are imported; **every chain call that names the registry goes through `src/chain-v2.mjs`, which takes the registry from config** — so the v2.1 switch is a config change, not a code change.

| Server piece | Backend module reused | What it does here |
|---|---|---|
| `src/chain-v2.mjs` (views/sends) | `src/chain.mjs` (`grpcClient`, `getTxStatus`, `getBlockTime`, `getAccountInfo`, `tokenBalance`, `encode/decodeCborMemo`); `src/v2/registry.mjs` (pure parsers: `parsePayableV2`, `parseVendorV2`, `parseAgentOf`); `src/v2/encoders.mjs` (all encoders); `src/v2/events.mjs` (`decodeLoggedEventsV2`); `src/send.mjs` (`loadSigners`, `sendTokenTransfer`, `nextNonce`); `src/v2/send.mjs` (`waitFinalized`, `rejectReasonOf`) | Parameterized views (`getPayable`, `getConfig`, `getVendor`, `getUsage`, `agentOf`, `getRegistryBalance`) + sends (`sendUpdate`, `sendTokenTransfer`) against the configured registry |
| `src/verifier-v2.mjs` | **New code (the v2 branch)** — the backend's `src/verifier/checks.mjs` is v1-only (hardcodes `<13149,0>`, `payable:<id>` memo, 8-byte pay_ccd param, v1 events). Same check discipline, v2 layouts | before_pay 9, after_pay CCD 10, after_pay EUDemo 12, PLT transfer gate. F10 closed on both rails: the pay tx's parameter AND the contract's `Paid` event must bind the same `(seller, id)` |
| `src/snapshot-v2.mjs` | Mirrors `src/v2/snapshot.mjs` (same shape, parameterized views) | Co-signer snapshot: view + account + EUDemo balance + approval/usage (chain-read) + agent status via `agentOf` on `<12802,0>` + transfer verification |
| `src/jobs.mjs` (pay flows) | `src/cosigner/decide.mjs` (`decide()` — pure); `src/mcp/server.mjs`'s `pay_payable` recipe (gate → reserve → gate → transfer → gate → confirm), adapted to v2 | CCD rail: payer B `pay_ccd`. EUDemo rail: B `reserve_plt` → B transfer (memo `payable:<seller>:<id>`) → **B `confirm_plt`** (see §7 — the confirm sender is the reserving payer, not the seller) |
| `src/ledger.mjs` | Mirrors `src/cosigner/ledger.mjs` | Append-only JSONL; transfer entries `unresolved` until confirm resolves them; `decide()` refuses a new reserve while one is unresolved |
| `src/receipts.mjs` | `src/receipt/build.mjs` (pure hash helpers: `sha256Hex`, `receiptIdFor`, `computeRecordHash` — via `backend()`) | Receipt rebuilt live; payment hash from store → evidence index → (EUDemo) the chain's own stored transfer hash |
| `src/docs.mjs` | Backend evidence: `test/v2-live-e2e-2026-11-24.json`, `test/live-e2e-2026-11-24.json`, `test/invoices/*.txt`, `contract/scripts/matrix-v2-result.json` | Lab documents (matrix marker strings, v2 invoice files, fresh docs), recorded runs, recorded refusals, judge-file inventory |
| `src/attacks.mjs` | `decide()` + the same send path as the jobs | Live chain attacks (§4) |
| `src/verify-payable-v2.mjs` | The verifier + chain layer in this package | Keyless CLI for judges: `node verify-payable-v2.mjs <id> <tx-hash> [--doc <path>]` |

**What is NOT reused, and why:** the MCP server (`src/mcp/server.mjs`) is v1-only and stdio — the API server drives the same underlying modules (`send` + `decide` + `snapshot` + `verifier`) directly, adapted to v2. The facilitator HTTP server is x402-specific and not part of the P3 contract. The v1 verifier/receipt/registry modules are untouched (the v1 run stays intact).

## 3. The pay flows (what a job does)

**CCD** (`check_status → check_agent → submit → wait_finality → read_back → verify`): pre-flight = the 9 before-pay checks (refuses without sending); `pay_ccd` from payer B with the stored amount attached; wait for finality (a chain reject → `refused` with the real code + fee); read back (must be `Paid`, registry balance 0); verifier 10/10; receipt stored (`server_store` — F5).

**EUDemo** (`check_wallet → reserve → co_sign_decide → submit_transfer → wait_finality → confirm → verify`): pre-flight; co-signer gate 1 (reserve) → `reserve_plt` from B → read back `Reserved` by B + `Reserved` event; gate 2 (transfer: recipient/amount/token/memo/header-expiry ≤ reservation−60 s) → EUDemo transfer from B → wait + transfer verification (8 checks, fail-closed — a bad transfer is never confirmed); gate 3 (confirm: transfer verified + inside the window) → `confirm_plt` **from B, the reserving payer** → read back `Paid` + `PltConfirmed` event; verifier 12/12; receipt stored (`chain`).

**Submission rule (P3 §7.5):** the tx hash is stored on the job the moment `sendTransaction` returns; a retry returns the existing running job, never a blind second send. A refusal after a send records the fee. No step sends anything the co-signer gate refused; no confirm is sent for an unverified transfer.

## 4. Attacks ("Try to break it")

- **`pay_twice`** — live when the payable is Paid: the second payment is REALLY sent (CCD `pay_ccd` → −5 `WrongStatus`; EUDemo `reserve_plt` → −16 `NotUnpaid`) and the real refusal + fee + tx hash are returned. `mode: precheck_only` sends nothing (app pre-check). If the chain ever accepted the second payment, it is reported as `unexpected_success` — never hidden.
- **`wrong_amount`** — CCD live: `pay_ccd` with amount+1 → −6 `WrongAmount` (real tx, real fee). EUDemo: co-signer dry-run refusal `wrong-amount`, no tx (computed live, on the hypothetical Reserved state the transfer gate requires — labelled; the payable itself is never reserved for an attack).
- **`unlisted_seller`** — `not_set_up`: no fraud payable exists on v2 (no second seller — D6; only the demo seller holds an Active agent token). Returns the recorded v1 example + two live checks run now: the vendor list (one seller, read from the chain) and a co-signer dry run for an unlisted seller (REFUSE `no-approval` — **on v2 the vendor list IS enforced by the co-signer**, unlike the v1 recorded run; the dry run assumes an Active agent for the placeholder seller, labelled as an assumption).

Attack sends are budgeted (3/hour/IP, reported in `/api/health`).

## 5. Balances, fees, thresholds (live numbers, 2026-11-24)

- **Fee headroom (50 CCD):** one send reserves maxEnergy 6000 NRG × the energy price (~0.0078 CCD/NRG) ≈ 47 CCD. The verifier's balance pre-flight and the health `payer: ok` threshold agree at 50 CCD — the frontend disables the CCD pay button unless the payer is `ok`, so the check and the button must agree.
- **Demo payer B funded:** B fell to 43.34 CCD after the first smoke run (below the 50 threshold) — funded with **500 CCD from the owner** (testnet transfer `05a66c3f8995e44b7ff7e47eebc6a1dda6f851312a8dee85de74f6eb325e3294`, fee 3.889984 CCD). B now 543.34 CCD, EUDemo 207.37. Owner 142,491.75 CCD.
- **Measured fees (testnet CCD):** register ≈ 16.4–16.7; CCD pay ≈ 16.2; refused pay/attack ≈ 5.4–5.7; EUDemo reserve/transfer/confirm ≈ 5–13.3. Refused txs cost a fee — shown on every refusal.

## 6. Numbers that are NOT chain counters (honest limits)

- `refused_on_chain_since_deploy` = distinct rejected tx hashes recorded in the evidence files for `<13150,0>` (the v2 matrix, 15) + refusals this server observes live (3 after the smoke runs: two −5, one −6 → 18). The contract exposes no refusal counter; the v1 registry's 7 recorded refusals are NOT included (different contract).
- `verifierRuns` / `last_verifier_run_at` count THIS server's verifier runs only (47 runs at report time, 36 all-pass — the 11 not-all-pass are the expected blocked/not-ready verifications from the tests: past-due, voided, doc-mismatch, unpaid after-pay).
- **Voided payables:** the P3 `PayableFacts` type has no voided variant. `/api/payables/4` returns `status.kind: 'unpaid'` with the label `Voided on chain — …`; the verify endpoint is the enforcement point and reports the real status (`blocked`, `blocked_reason: 'status'`).
- **Matrix payables 1–5:** their registered document is exactly the marker string `payonce-live-matrix-<n>` — sha256 of that string IS the on-chain `doc_hash` (proven in the live tests). No invoice text exists for them; the fresh-payable flow is the demo path with real lab invoices.

## 7. Bugs found live during the smoke runs (fixed, with evidence)

1. **Confirm sender was wrong (found 2026-11-24 ~10:53, fixed same hour).** The first EUDemo smoke job sent `confirm_plt` from the owner (seller) — the chain refused **−17 `NotPayer`** (fee 5.745685 CCD, tx `7ded67fd78341574bb64b68adf21197ccad3ba1cd88f6ce1edcf55db94bdcc37`). Root cause: I carried over v1's "confirm by seller" — in v1 the seller WAS B, but on v2 the confirm entrypoint requires the **reserving payer** (B). The v2 E2E proves it (its confirm was sent by `signers.sellerB`). Fix: `src/jobs.mjs` sends the confirm from B; `config.build.confirm_by` now reads `'payer (the reserving payer)'`. **Payable #1001 was recovered manually** with the correct sender (gate SIGN, confirm tx `4bfc190f414568428870867953cb249bb7c77c3a71ec15e250ac72d408cf8d72`, fee 13.284955 CCD → status Paid, receipt 14/14). Its ledger entry was resolved. The clean re-run then passed the full EUDemo rail.
2. **Nonce contention with the parallel v2.1 worker (found ~10:48).** The owner's nonce advanced 211 → 226 in ~11 minutes while the v2.1 worker deployed — owner sends collided (`Duplicate nonce`). Fix: `src/chain-v2.mjs` — owner sends wait for a quiet window (nonce stable 6 s, max 90 s) before building the tx, plus a bounded duplicate-nonce retry (6 attempts; a rejected tx never entered the mempool, so rebuilding with a fresh nonce cannot double-send). B's sends are unaffected (B's nonce is stable).
3. **Balance-read bug (found in the first live run).** The backend's `getAccountInfo` requires a block hash; my chain layer called it without one → verify/health 500/empty. Fix: `getAccount` resolves the last finalized block itself + a `microCcdOf` helper for the JSON amount shape.

## 8. Tests

```bash
npm run test:unit   # 10/10 — config, matrix doc-hash rule, doc generation,
                    #   v2 encoders, event-decoder errors, reject table -1..-27,
                    #   job step lists, rate limits, decide() wrong-amount + no-approval
npm run test:live   # 16/16 — every GET endpoint + verify/dry-run/precheck
                    #   attacks, against the REAL testnet. No sends.
npm run smoke       # FULL E2E with real sends (see §9). Run explicitly.
```

**Live-test proofs (all against the real testnet):** config reports v2 `<13150,0>` + official CIS-8004 module `0e574737…`; P1's on-chain `doc_hash` equals sha256(`payonce-live-matrix-1`); P10/P11 invoice docs hash to `c9fef19a…` / `f02ed5c9…`; **after_pay P10: 10/10, P11: 12/12**; receipts rebuild live (P10 10/10, P11 14/14 incl. the 2 receipt-binding extras); dry-run refuses `not-reserved` (P3) and `already-paid` (P11); stats count 7 known payables (2 paid) before the smoke runs.

## 9. Live evidence — smoke runs (testnet, 2026-11-24)

**Run 1 (bug-finding run):** fresh CCD **#1000** — register `11d9bd39…` (fee 16.662486), pay `73be55cd14ae2c054b899f0a82dc1f2a88f905e5ca20adc7af334ad94242ac69` (10/10), receipt 10/10, re-pay 409 `already_paid`, live `pay_twice` −5 (tx `69bb51fa240738f0a8d741e32d9c6003931c98207707253ccb86a7f0d3f41014`, fee 5.419579). Fresh EUDemo **#1001** — reserve `9de70c9ca3d6f9ad206331be38a6f988804b895081e5731a092b755926f439d4`, transfer `0b4199feae8b93d33c3578e8a59a4ec950751638db4cdab460e32fb8267603f2` (verified 8/8), confirm refused −17 (see §7.1), recovered manually (confirm `4bfc190f…`, receipt 14/14).

**Run 2 (clean full pass, after the fix):** fresh CCD **#1002** — register `b630319d…` (fee 16.375202), pay `a40d8098bc9aed471468e5dffbb391d09d7ae1a5df351a616bbde2b63efd84e1` (10/10), SSE 11 step events + done, receipt 10/10, after_pay 10/10, re-pay 409, live `pay_twice` −5 (tx `7d37ec8e82fdc02192ffa3d14f794174fbf8ceee849f5bdb28b107b84199dd72`, fee 5.419579). Fresh EUDemo **#1003** — register `92a0801a…` (fee 16.716837), reserve `030782b1a4f6db5872a5d72463da82d1f3a7f48991c53a283cc6e8c473383822`, transfer `f6eb219274932ec06917c9de38c339808885e6741b31b99cf2696dc89bcaae30`, confirm `f9b1f49e44234f4277e00ac39efb613725970f9f27575f8d48ead57290d62ef5` (12/12), receipt 14/14, after_pay 12/12. Fresh CCD **#1004** (wrong-amount target, unpaid) — live `wrong_amount` −6 (tx `a5e6c6b2589b5dfd89e7c59b54e36ceec232f2bb6fc961cf37a4ee96f2dfc584`, fee 5.411814). Stats after: `payables_total=12, paid_total=6, refused=18`.

## 10. How to run / switch to v2.1

```bash
npm install            # here (api/) AND in the backend/ (both need node_modules)
npm start              # http://127.0.0.1:7401
```

Env: `PAYONCE_BACKEND_DIR` (auto-detected), `PAYONCE_REGISTRY_INDEX` / `PAYONCE_REGISTRY_MODULE` (set to the v2.1 instance when it lands — no code change), `PAYONCE_ENV_PATH` (wallet env, only needed for sends). Signers load lazily, in-process only, on the first send; every read-only endpoint works without them. State lives in `api/data/` (`jobs.json`, `receipts.json`, `counters.json`, `documents/`, `cosigner-ledger.jsonl`). **No git in this work dir** (the integration lead owns the repo); `node_modules` here and in the repo `backend/` are symlinks to the work-tree backend's install for development — a real deployment runs `npm install` in each package.

## 11. Files

```
api/
  package.json, README.md, API_REPORT.md (this file)
  src/
    server.mjs          # HTTP server, all 16 endpoints + SSE + downloads
    config.mjs          # env + constants (registry, roles, limits, fees)
    backend.mjs         # backend resolution + dynamic imports
    chain-v2.mjs        # parameterized v2 views/sends, nonce handling
    verifier-v2.mjs     # v2 verifier: before_pay 9, CCD 10, EUDemo 12, transfer gate
    snapshot-v2.mjs     # parameterized co-signer snapshot builder
    ledger.mjs          # co-signer ledger (JSONL)
    jobs.mjs            # pay jobs (CCD + EUDemo rails), SSE fan-out
    attacks.mjs         # pay_twice / wrong_amount / unlisted_seller
    receipts.mjs        # live receipt rebuild + re-verification
    docs.mjs            # lab documents + recorded evidence index + judge files
    store.mjs           # jobs/receipts/counters/rate-limit windows (JSON)
    verify-payable-v2.mjs  # keyless v2 verifier CLI for judges
  test/
    unit.test.mjs  live.test.mjs  smoke.mjs
  data/                 # runtime state (jobs, receipts, counters, documents, ledger)
```

## 12. Open items / notes for the paired judge

- The frontend's `JudgesPage` still carries v1 copy (registry `<13149,0>`, sample txs, "the co-signer would also approve it" for the fraud case, "seller's agent is on our test instance"). That is frontend content, not this server — but the config this server returns (`confirm_by`, vendor-list enforcement) now contradicts the v1 page text; the frontend worker should update it to v2.
- The frontend's `TryPanel` known-limit line for `unlisted_seller` is the v1 honest gap; on v2 the co-signer refuses (`no-approval`) — the API returns the live result; the page text should follow.
- `POST /api/payables/:id/pay` on a payable Reserved **by our own payer** (e.g. after a crashed job mid-rail) returns 409 `reserved_by_other` — there is no resume path yet; a recovery would need to re-verify the existing transfer and confirm it (as was done manually for #1001). Worth a follow-up, not a blocker: jobs are idempotent by de-dup while running, and the chain refuses a second reserve/pay in every case.
- F1 (−18) and F5 (pay_ccd tx hash) are v2.1 scope (contract worker) — this server already reads the payment hash from its store/evidence for CCD and from the chain for EUDemo; on v2.1 the CCD path can switch to `chain` once `record_payment_tx` lands.
- The `stats.refused_on_chain_since_deploy` method is documented in §6 — it is not a chain counter.
