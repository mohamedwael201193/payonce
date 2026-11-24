# PayOnce — BACKEND REPORT

**Domain:** backend only (verifier, co-signer, facilitator, x402 flows, MCP, receipts, EasyPost capture, D5 adapter).
**Network:** Concordium **testnet only**. No mainnet, ever. No mocks, no fakes, no stubbed flows.
**Work dir:** `~/workspace/payonce-build/backend/`
**Date:** 2026-11-24 (all times UTC unless marked EET).
**Status: COMPLETE — full test suite 110/110 pass, 0 fail.** Every live flow executed against testnet with real tx hashes below.

## 1. Verdict summary

| Item | Result |
|---|---|
| F10 verifier fix (CCD binds tx to invoice number) | **PROVEN LIVE** — baseline payable 1 = 11/11 PASS; cross-invoice negative N-01 (payable-1 check with payable-4 tx) now FAILS on CCD-04 + CCD-05 |
| Verifier CCD / PLT | 12/12 and 15/15 (incl. doc-hash CCD-12 / PLT-15) |
| Negative tests | 12/12 (N-01..N-08 + baselines + memo unit + Unpaid-view regression) |
| Co-signer `decide()` | 41/41; co-signer server 7/7 |
| Live E2E v1 (Rail A CCD / Rail B EUDemo) | 12/12 / 15/15 |
| x402 E2E (Rail A / Rail B) | 8/8 / 15/15 |
| Live E2E v2, contract `<13150,0>` | 8 txs finalized, all 3 co-signer gates SIGN, views + balance deltas verified |
| Facilitator (Doris 9 checks + 4 safeguards) | 8/8 tests, verify-only, no settles in tests |
| MCP server | **18/18**; live pay through `tools/call` — Rail A 12/12, Rail B 15/15 |
| Receipt / Art. 12 verifier | 8/8 tests; receipts 006 17/17, 007 20/20, 010 17/17, 011 20/20 |
| EasyPost test tracking | 4/4 tests; shipment `shp_4415e60965da4a90b74525ff327b281b` |
| D5 invoice adapter | 12/12 tests; OFF by default |
| **Full suite (one run, all files)** | **110/110 pass, 0 fail** |

## 2. F10 proof — the verifier now binds the transaction to the invoice number

**The bug:** the CCD verifier passed invoice 1's check using invoice 4's transaction (no binding between payable id and the payment tx).

**The fix (`src/verifier/checks.mjs`, CCD checks renumbered CCD-01..CCD-12):**
- **CCD-04 — parameter binding:** the `pay_ccd` parameter (payable id, u64 LE) must equal the invoice's payable id.
- **CCD-05 — Paid-event binding:** the `Paid` event's payable id must equal the invoice's payable id.

**Proof (live, testnet):**
- Baseline payable 1, pay tx `00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6` → **11/11 PASS** (doc-hash check skipped — the stored doc hash for payable 1 predates the invoice file).
- Baseline payable 2 (PLT), transfer tx `7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef` → **14/14 PASS** (doc skipped).
- **Negative N-01:** payable 1 checked against payable-4 tx `78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e` → **FAILS on CCD-04 (parameter id=4, requested=1) and CCD-05 (Paid event id=4)**. This is the exact cross-invoice case that previously passed.
- All 12 negatives run offline from fixtures in `test/fixtures/` (`test/verify-negatives.test.mjs`, 12/12).

## 3. Verifier scores (live)

| Run | Checks | Result |
|---|---|---|
| v1 E2E Rail A — payable 6 (CCD 0.5) | CCD-01..CCD-12 | **12/12 PASS** (incl. doc-hash CCD-12) |
| v1 E2E Rail B — payable 7 (EUDemo 0.01) | PLT-01..PLT-15 | **15/15 PASS** (incl. doc-hash PLT-15) |
| x402 Rail A — payable 8 (CCD 0.5) | 8 checks | **8/8** (see §7 honest limit) |
| x402 Rail B — payable 9 (EUDemo 0.01) | PLT-01..PLT-15 | **15/15 PASS** |
| MCP live pay Rail A — payable 10 (CCD 0.5) | CCD-01..CCD-12 | **12/12 PASS** |
| MCP live pay Rail B — payable 11 (EUDemo 0.01) | PLT-01..PLT-15 | **15/15 PASS** |

Evidence files: `test/live-e2e-2026-11-24.json`, `test/x402-e2e-2026-11-24.json`, `test/v2-live-e2e-2026-11-24.json`, `test/mcp-live-pay-2026-11-24.json`.

## 4. Co-signer — deterministic decision gate, never moves funds alone

Modules: `src/cosigner/{decide,ledger,snapshot,signer,server,recheck}.mjs`.

- `decide()` is **pure** (never reads `Date.now()`), a deterministic function of on-chain state; re-runnable by anyone from the snapshot.
- The ledger is written **before** signing. The co-signer has an isolated key and **cannot move funds alone**; it refuses the 7 wrong-transfer kinds + expired tx + non-vendor seller + earlier payment (H1/H2/race, header-expiry bound = expiry − 60 s).
- `decide()` already supports v2 snapshots: `canonicalMemoV` returns `payable:<seller>:<id>` when `snapshot.version === 2`.
- Tests: **decide 41/41** (C-01..C-34 + 5 confirm cases + C-04b/c), **server 7/7** (incl. C-35 ledger-write-failure → 403, no signature).
- Sponsor check is vacuous when both sponsor accounts are null (live runs are non-sponsored — documented deviation from the sponsored design).

**Key-derivation finding (read-only probe `spikes/derive-keys.mjs`):** the seed phrase derives all three accounts via `ConcordiumHdWallet.fromSeedPhrase(seed, 'Testnet')`, identity 1: counter 0 = owner `42jaZZ…` (derived signing key **equals** the env private key), counter 1 = seller B `4MvdMEGC…`, counter 3 = agent C3 `3cjnRyk51…` key 0. **C3's keys 1–2 are NOT in the seed** — a 2-of-3 C3 transaction cannot be submitted from here. Live E2E therefore runs buyer/seller roles with owner + B keys; the co-signer acts as decision gate and its signature is recorded as an **attestation** in the ledger + receipt, **not** as an on-chain co-signature. C3 is 1 credential, 3 keys, threshold 2.

## 5. Live E2E v1 — contract `<13149,0>` (2026-11-24 ~08:00–08:02 UTC)

**Rail A — payable 6 (CCD 0.5):** register `5c228c4f…`, pay_ccd `828ebd25…` (owner → payee `4Vtd…`). Verifier 12/12 incl. doc-hash. Paid 2026-11-24T07:58:41Z, due 2026-11-25T07:55:46Z.
**Rail B — payable 7 (EUDemo 0.01):** register `b2455eff…`, reserve `68264db8…` (co-signer gate SIGNED; **Reserved view layout VALIDATED live** — payer + expires 2026-11-24T08:05:09Z, 300 s window), transfer `1badea82…` (B → payee2, memo CBOR `payable:7`), confirm `459734c3…` (gate SIGNED after on-chain transfer verification). Verifier 15/15 incl. doc-hash.

## 6. Live E2E v2 — contract `<13150,0>` (2026-11-24 ~08:36–08:38 UTC)

Closes Gate G0 #1's live-success gap (the contract judge had marked it PARTIAL only because it believed no second key existed — the seed does derive B's key, §4).

**Roles MIRRORED vs the original ask, for a documented on-chain reason:** seller = owner (`42jaZZ…`), payer = B (`4MvdMEGC…`). B owns **no agent token on the official registry `<12802,0>`**: `agentOf(1)` and `agentOf(1261)` return other owners (both Active), `agentOf(1476)` = owner/Active; a CIS-2 `balanceOf` scan could not complete (the registry rejects even the SDK's standard CIS-2 encoding with `RejectedReceive -2147483648`; the SDK's own `CIS2Contract.balanceOf` also failed). B therefore CANNOT register on v2 (would fail −10 AgentOwnerMismatch for any token it does not own). The mirror exercises every guard identically (−27 payer≠seller, −21 expected payer, −19 approval, −23 caps, −8/−9/−10 agent check, atomic forward, −18 invariant). B's official-registry onboarding stays the open D6 item for the user.

All 8 txs finalized, all 3 co-signer gates SIGN, all views + balance deltas verified:

| Step | Tx | Fee |
|---|---|---|
| Fund B +100 CCD (setup) | `7faad552535756b759700ea59f082e2a376e5b5875dfff75df05079c3881fdc4` | 3.895302 CCD / 501 NRG |
| approve_vendor (B approves owner, tier 2, perCap 100 CCD / periodCap 1000 CCD / 86400 s) | `6a6264acc1aa5a0b2b708f77d9c39d7a5d931a254b60c53c8150d65f347f7462` | 9.166787 CCD / 1179 NRG |
| Rail A — register payable 10 (CCD 0.5, payee1, token 1476, expected_payer=B) | `e36da695159bfb809d96b732c9d056cead0ccf357e4a2a763ccc801625b606f9` | 16.32761 CCD / 2100 NRG |
| Rail A — pay_ccd (B pays) | `7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197` | 19.554257 CCD / 2515 NRG |
| Rail B — register payable 11 (EUDemo 0.01, payee2, expected_payer=B) | `129f8943fd5c8a08241fe608899792acde712fe1ae3d9ee1d0eb067d2a790851` | 16.739688 CCD / 2153 NRG |
| Rail B — reserve_plt (B) | `a36aa1e0d2ea71a4702075cd0d94752fac7f088dfb52d4038322b7e617180f0d` | 17.400567 CCD / 2238 NRG |
| Rail B — EUDemo transfer B → payee2, memo `payable:<owner>:11` | `690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214` | 5.652463 CCD / 727 NRG |
| Rail B — confirm_plt (B) | `adf55f61c1345d14f05c6c0ee59b996dae8aaef06213e485a17cfb96376100c2` | 12.906587 CCD / 1660 NRG |

Results: Paid event decoded (payer B, 500000, CCD); view Paid by B 2026-11-24T08:37:45Z; payee1 CCD **+500000 microCCD exactly**; contract balance 0. Rail B: Reserved view payer B, window **exactly 3600 s** (expires 2026-11-24T09:38:01Z); PltConfirmed event (txHash pinned, reservation_expires kept — F11); view Paid by B 2026-11-24T08:38:19Z; payee2 EUDemo **+10000 base units exactly**. Balances reconcile to the microCCD (owner 143,843.572035 → 143,706.609435; B 74.204247 → +100 → 109.023586). Nonces: owner 189 → 192, B 59 → 64.

**Two live lessons recorded in code:** (1) the node requires balance ≥ maxEnergy × rate (~0.0078 CCD/NRG) — a 30000-NRG cap (~234 CCD) exceeds B's balance and the send is rejected outright; v2 send cap is now 6000 NRG (~47 CCD max; actuals 1179–2515). (2) `Payload.transfer` takes `toAddress`, not `to`.
**v2 snapshot builder** closes the v1 gaps: approval + usage chain-read via get_vendor/get_usage; agent status chain-read via agentOf on the official registry. memoScan remains operator-maintained (the contract's used_tx set is the authoritative on-chain reuse guard, −12).

**v2 layouts proven from source + live (do not improvise):** read `~/workspace/payonce-build/contract/payable_registry_v2/src/lib.rs` and `~/workspace/payonce-build/contract/scripts/matrix-v2.mjs`. register_payable = id u64 + payee 32B + amount u64 + asset (0x00 CCD / 0x01 + u32 len + symbol) + due u64 ms + doc_hash 32B + agent_token u64 + expected_payer Option + legal_ref Option. pay_ccd / reserve_plt / expire_reservation param = PayableKeyParam (seller 32B + id u64). confirm_plt = seller 32B + id u64 + tx_hash 32B. approve_vendor = seller 32B + tier u8 + legal Option + perCap u64 + periodCap u64 + periodSecs u64. void = id u64 only. View: [0] Some flag; seller 32B; id u64; payee 32B; amount u64; asset; due u64; docHash 32B; token u64; expected Option; legal Option; status 0 Unpaid / 1 Reserved (payer + reserved_at + expires) / 2 Paid (payer + reservation_expires Option + paid_at + tx_hash Option) / 3 Voided (voided_at).

## 7. Facilitator — Doris's 9 checks + 4 sponsor safeguards

`src/facilitator/{scheme,server,client}.mjs`, wrapping `@x402/concordium` 2.32.0 `ExactConcordiumScheme` + PayOnce layer (payable exists/status, amount == stored, payee == stored, PLT memo == canonical `payable:<id>`). Sponsor = owner (in-process signer, never logged). **4 safeguards:** verify-before-sign, in-memory-only keys, per-IP rate limit 30/min, balance watch (sponsor 143,843.57 CCD at smoke test, low threshold 50 CCD). Server: GET /health, /supported; POST /verify, /settle (JSONL ledger `test/facilitator-ledger.jsonl`); malformed payload returns clean 400. **Tests 8/8** (`test/facilitator.test.mjs`, verify-only, no settles): wrong amount/memo/recipient all REFUSE; correct transfer VALID.

## 8. x402 flows (2026-11-24 ~08:07–08:09 UTC)

**Rail A — payable 8 (CCD): 8/8 checks.** Register `81bc1595…`; stock x402 client payload; facilitator verify VALID; settle `74a06a175440a7a0031e67a0662d2e35d7404b8bf69105276b0966ff87dc6283` (payer B; sponsor paid 4,939,617 microCCD fee, sender cost 0; full hash pinned in `test/x402-e2e-2026-11-24.json` — an earlier draft cited this settle as `f953c9cb…`, which matches no evidence JSON and is withdrawn).
**Honest limit:** x402 Rail A is a **DIRECT transfer to the payee, not the contract's `pay_ccd`** (the facilitator only settles simple transfers/tokenUpdates) — payable 8 stays **Unpaid** on-chain; the receipt says so.
**Rail B — payable 9 (EUDemo): 15/15.** Register `20616923…`; reserve `97a3a72d…` (gate SIGN, expires 08:13:11Z; full hash not recorded — truncated citation only, the reservation itself is proven by the on-chain Reserved view + PLT-13); custom memo'd v1 transfer via facilitator (stock client sets `memo: void 0` — PayOnce builds the transfer with the web-sdk instead) settle `441b470f…`; confirm `9e93cddd…` (gate SIGN); verifier PLT-01..15 all PASS.

## 9. MCP tool server — 18/18, plus live pay through `tools/call`

`src/mcp/server.mjs` (stdio MCP server `payonce` v1.0.0, SDK 1.32.2, 4 tools reusing existing modules: `verify_invoice`, `pay_payable`, `receipt`, `list_payables`; validation-first in `pay_payable`, signers load only after all checks pass; thrown errors surface as `isError` results, no crash) and `test/mcp.test.mjs` (18 tests: live chain reads + validation-only pay tests + stdio smoke test).

**Three failures found and fixed during close-out:**
1. **list_payables expectation** — live state drifted (payables 8/9 registered by the x402 run; later 10/11 by the MCP live-pay run). Expectation updated to live truth: 1,2,4,6,7,9,10,11 Paid; 3,5,8 Unpaid; 10 = CCD 500000, 11 = EUDemo 10000.
2. **pay_payable mismatched-doc** — `validatePayableForPayment` checked status before doc, so Paid payable 6 + wrong doc reported "already Paid" instead of "doc mismatch". Reordered: rail/asset → doc → status → amount → due → balances.
3. **stdio smoke test hang (root cause found):** SDK `Client.callTool` hung until the 60 s timeout while a raw JSON-RPC probe answered the identical `tools/call list_payables` in ~1.8 s. Diagnosis: wire-log tee proved the server received the call but never responded; temporary `[mcp-diag]` stderr logging proved the tool callback WAS entered but `listPayables` hung on the FIRST `getPayableOrNull` → gRPC `invokeContract`; protocol version ruled out (raw probe with `2025-11-25` answered in 1.7 s); SDK source showed `StdioClientTransport` spawns the server with ONLY HOME/LOGNAME/PATH/SHELL/TERM/USER (`getDefaultEnvironment`), stripping the proxy vars this sandbox needs (`https_proxy`, `HTTPS_PROXY`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `no_proxy`) — the server's gRPC connection to `grpc.testnet.concordium.com:20000` then hangs on a direct connection instead of going through the proxy. **Fix:** the stdio smoke test passes `env: process.env` to `StdioClientTransport`; the server header documents the env requirement for any stripping host. Temporary diag logging removed. Temp probes deleted.

**Live pay through the real MCP server (`spikes/mcp-live-pay.mjs`, evidence `test/mcp-live-pay-2026-11-24.json`):**
- **Rail A — payable 10 (CCD 0.5):** register `895d1d6d…` (14.772941 CCD / 1909 NRG); pay via `tools/call pay_payable` `83b11aff…` (16.568291 CCD / 2141 NRG); **verifier 12/12, Paid** 2026-11-24T09:43:17Z.
- **Rail B — payable 11 (EUDemo 0.01):** register `d028c9fb…` (15.028314 CCD / 1942 NRG); reserve `39312e6d…` (14.370535 CCD / 1857 NRG); transfer `6986b191…` (5.2158 CCD / 674 NRG); confirm `8464b885…` (11.561432 CCD / 1494 NRG); **verifier 15/15, Paid** 2026-11-24T09:53:41Z.
- **Incident during Rail B (fixed, recorded in the evidence file):** the first attempt's reserve + transfer landed but the **confirm submit was rejected by the node** — maxEnergy 10000 NRG × rate ≈ 78 CCD max cost exceeded B's ~60 CCD balance at that moment. The transfer's effect was verified via balances (payee2 EUDemo 100060000 → 100070000, B 207400000 → 207390000) but its tx hash was never returned by the tool, so it could not be confirmed. An expire attempt then failed **−13 NotExpired** — correctly: its block slot time 09:47:41Z was before the reservation expiry 09:48:27Z (tx `2cd0eab5…`, 4.991382 CCD fee, contract guard worked). After expiry, expire succeeded (`c18c159d…`, 8.760068 CCD), payable 11 returned to Unpaid, B was funded +50 CCD (`8db3ac9d…`), and the MCP redo completed cleanly. **Fix applied in `src/mcp/server.mjs`:** maxEnergy **6000n** on all pay-path sends (~47 CCD max cost); Rail B fee check raised to **100 CCD up front** so the tool refuses BEFORE reserving instead of dying at the confirm. Consequence: payee2 received 10000 EUDemo twice for payable 11 (first-attempt transfer + redo transfer); the redo transfer is the one pinned by the confirm and the verifier — recorded honestly, same class of test artifact as payables 7/9 (§11).

## 10. Receipt / Art. 12 verifier — walletless, re-verifies from chain alone

`src/receipt/{build,verify,cli}.mjs`. Receipt has receiptId, recordHash, nonce, verifier list, honest testnet footer. **Tests 8/8** (`test/receipt.test.mjs`). Real receipts built and verified:

| Receipt | Payable | Verifier | Total checks |
|---|---|---|---|
| `test/receipts/receipt-006.json` | 6 (CCD) | 12/12 | **17/17** |
| `test/receipts/receipt-007.json` | 7 (EUDemo) | 15/15 | **20/20** |
| `test/receipts/receipt-010.json` | 10 (CCD, MCP-paid) | 12/12 | **17/17** |
| `test/receipts/receipt-011.json` | 11 (EUDemo, MCP-paid) | 15/15 | **20/20** |

receipt-010: receiptId `3cdc8c6c5479a338a51e97774f710f57d6246fa08acebbbcb9bf1f7569f51ff4`, recordHash `b59aaa77df4622363ec2f2f6f97abcd7df1c726c18576ebd10332f75de242798`. receipt-011: receiptId `2559f4da37965d09206dc046ed37fae2565a025422318468f64a94bd02bb8e6f`, recordHash `0b81fe42af65adbef3fbf6765d6d8904bf83bdf8f059c7c4bd63868336056ec0`. Verify: `node src/receipt/cli.mjs verify <receipt.json> --doc <invoice>`.

## 11. EasyPost test tracking + D5 adapter

**EasyPost** (`src/easypost/{capture,cli}.mjs`, test mode only). Evidence `test/easypost-capture-2026-11-24.json`: shipment `shp_4415e60965da4a90b74525ff327b281b`, tracking `9434600208192110798897`, test label URL. **Tests 4/4** (`test/easypost.test.mjs`). Findings: installed `easypost@0.1.1` is NOT the real EasyPost client (unrelated "read POST data" helper) — `capture.mjs` calls the REST API directly; test-mode tracker quirk: standalone tracker uses documented test code `EZ4000000004` (delivered), shipment's real tracking code tracked via its auto-created tracker.
**D5 adapter** (`src/invoice-adapter/{adapter,guard}.mjs` — ScriptedAdapter + LLM stub, **OFF by default**, guard reads the real payment-path files; **12/12 tests**). Enable via `enableAdapter('scripted')` or `PAYONCE_INVOICE_ADAPTER` env var. No LLM in the payment path.

## 12. Refusal matrix (what the backend refuses, proven by tests)

| Refusal | Where proven |
|---|---|
| Cross-invoice tx (payable-1 check with payable-4 tx) | verifier N-01 → FAIL CCD-04 + CCD-05 |
| Wrong amount / wrong memo / wrong recipient (facilitator) | facilitator tests 8/8 |
| Wrong rail, already-Paid, nonexistent payable, mismatched doc, invalid rail (MCP pay) | MCP tests 18/18 (validation-only, nothing sent) |
| Co-signer: 7 wrong-transfer kinds + expired tx + non-vendor seller + earlier payment | decide 41/41 + server 7/7 (incl. ledger-write-failure → 403, no signature) |
| Rail B with < 100 CCD fee headroom | MCP server fee check (added 2026-11-24 after the live confirm-rejection incident, §9) |
| Malformed facilitator payload | clean 400, not 500 |
| Expire before expiry | contract −13 NotExpired, proven live on tx `2cd0eab5…` (§9) |

## 13. Test-artifact duplicates (honest record — payees received extra test funds)

- payee2 received 0.01 EUDemo twice for payable 7 (extra `ddf21bf7c38af5db728bf069a727fb49cb0d6b7ee915ebb6f8da3ff468aa3328` — a crashed run re-sent before the confirm) and twice for payable 9 (confirmed `441b470f6d900996a7fef45ac34b8ed4511f8dbd8df37c9cc76edfc67b1fc4c3` + a second transfer cited only as the unrecoverable prefix `11af6df6…`, full hash not recorded), and 0.5 CCD twice for payable 8 (verified settle `74a06a175440a7a0031e67a0662d2e35d7404b8bf69105276b0966ff87dc6283` + a second settle cited only as the unrecoverable prefix `acb36b6f…`, full hash not recorded; an earlier draft cited `f953c9cb…` for the settle — withdrawn, it matches no evidence JSON). The confirmed/verified tx is the one pinned by the checks (PLT-11 / X402-A2/A3); the further duplicate(s) are proven by balance effect only (payee2 EUDemo 100.00 + 8×0.01 = 100.08).
- payee2 received 0.01 EUDemo twice for payable 11 (first-attempt transfer, hash unrecovered, + redo transfer `6986b191…`); the redo transfer is the confirmed one (§9).

## 14. Honest limits

1. **x402 Rail A is a direct transfer, not `pay_ccd`** — payable 8 stays Unpaid on-chain by design (§8).
2. **Co-signer signature is an attestation, not an on-chain co-signature** — C3 keys 1–2 are not derivable from the seed (§4).
3. **v2 roles mirrored** — seller = owner, payer = B — because B owns no official-registry agent token (§6). D6 (second seller / B's onboarding) is open and is a user step.
4. **P10 agent-tx sponsorship was not used live** — B paid its own fees on the pay/reserve/confirm sends. The x402 facilitator sponsor DID pay the settle fees (proven by sender cost 0 on settle8 `74a06a17…` and transfer9 `441b470f…`). The facilitator's sponsor path is implemented and verify-tested; the P10 agent-sponsorship path is not settle-tested on sponsored flows.
5. **The hosted testnet facilitator key is a user step** (DM Piotr on Discord); the self-hosted facilitator is the fallback and is what is built here.
6. **Node quirk observed 2026-11-24:** `getBlockItemStatus` intermittently fails with gRPC `INTERNAL` (both a known-good tx and the expire tx) while `getPayable`/`waitFinalized` keep working — transient; retried successfully via `waitFinalized`.

## 15. What is still open

- **D6 — second seller / B's official-registry agent token** (user step; blocks seller-B roles on v2).
- **Hosted facilitator API key** (user step — DM Piotr).
- **F1 (−18 v2.1 redeploy)** — parent call, not a backend change.
- **F7 (two-clean-builds reproducibility)** — contract-side.
- **Exec approval timeouts** — one of my exec calls returned a system note that an approval "was not answered in time, so what it covered was not performed"; the probe output was delivered in full and no work was lost. The MCP subagent's handoff also recorded two such notices plus 4 pending/timed-out permission requests in the daemon mirror (approval_ids fcdeea09, f0f023aa, 5a94807e, c02ef805). Flagged for the parent; do NOT retry any approval-gated part unless the user asks.

## 16. Final live state (read 2026-11-24 ~10:00 UTC)

| Account | CCD | Nonce | EUDemo |
|---|---|---|---|
| owner `42jaZZ…` | 143,581.787 | 195 | 30.000000 |
| seller B `4MvdMEGC…` | 114.737 | 73 | 207.380000 |
| payee1 `4gedLUop…` | 157.584 | 9 | 0 |
| payee2 `4Vtd6WnC…` | 184.976 | 46 | 100.080000 |

**v1 payables (`<13149,0>`):** 1, 2, 4, 6, 7, 9, 10, 11 Paid; 3, 5, 8 Unpaid (3 and 5 are EUDemo 10000, seller B, due 2026-11-25 ~04:49 UTC; 8 is CCD 500000, Unpaid by design, §8); 12+ unregistered.
**v2 payables (`<13150,0>`):** (owner,1/2/3/5) Unpaid, (owner,4) Voided, (owner,10) Paid, (owner,11) Paid; (B,10/11) absent.

## 17. File inventory (all under `~/workspace/payonce-build/backend/`)

- `src/verifier/checks.mjs` — CCD 12 / PLT 15 checks.
- `src/cosigner/{decide,ledger,snapshot,signer,server,recheck}.mjs` — decision gate.
- `src/chain.mjs`, `src/send.mjs`, `src/registry.mjs`, `src/events.mjs` — chain I/O, v1 encoders, views, events.
- `src/facilitator/{scheme,server,client}.mjs` — x402 facilitator.
- `src/invoice-adapter/{adapter,guard}.mjs` — D5 adapter (OFF by default).
- `src/receipt/{build,verify,cli}.mjs` — Art. 12 receipts.
- `src/easypost/{capture,cli}.mjs` — test tracking capture.
- `src/mcp/server.mjs` — MCP tool server (4 tools).
- `src/v2/{registry,encoders,send,snapshot,events}.mjs` — v2 happy-path modules.
- `test/{verify-negatives,decide,cosigner-server,facilitator,invoice-adapter,receipt,easypost,mcp}.test.mjs` — 110 tests, all passing.
- `test/fixtures/*`, `test/invoices/invoice-00{6,7,8,9}-*.txt`, `test/invoices/invoice-010-v2-ccd.txt`, `test/invoices/invoice-011-v2-eudemo.txt`, `test/invoices/invoice-010-ccd.txt`, `test/invoices/invoice-011-eudemo.txt`.
- `test/live-e2e-2026-11-24.json`, `test/x402-e2e-2026-11-24.json`, `test/v2-live-e2e-2026-11-24.json`, `test/mcp-live-pay-2026-11-24.json`, `test/receipts/receipt-00{6,7}.json`, `test/receipts/receipt-010.json`, `test/receipts/receipt-011.json`, `test/easypost-capture-2026-11-24.json`.
- `test/facilitator-ledger.jsonl` — NOT present in this tree: the file is created by the facilitator HTTP server's `/settle` on the first server-mediated settle; the x402 settles in §8 went through the in-process client, not the HTTP server, so no ledger was recorded yet.
- `spikes/{save-fixtures,derive-keys,dry-run-send,live-e2e,x402-e2e,v2-live-e2e,mcp-live-pay,v2-probe-agents,v2-probe-b-token}.mjs` (+ older probes; temp diagnosis probes deleted).

## 18. How a stranger re-verifies this

```bash
cd ~/workspace/payonce-build/backend
node --test test/*.test.mjs            # 110/110 pass, 0 fail
node src/receipt/cli.mjs verify test/receipts/receipt-010.json --doc test/invoices/invoice-010-ccd.txt   # 17/17
node src/receipt/cli.mjs verify test/receipts/receipt-011.json --doc test/invoices/invoice-011-eudemo.txt # 20/20
node src/mcp/server.mjs               # stdio MCP server; call tools/list, then tools/call list_payables
```
Every tx hash above is a finalized testnet transaction on contract `<13149,0>` (v1) or `<13150,0>` (v2), gRPC `grpc.testnet.concordium.com:20000`. No secret is printed, logged, or committed anywhere in this tree; the env key is used in-process only.
