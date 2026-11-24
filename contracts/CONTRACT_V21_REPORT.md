# CONTRACT v2.1 REPORT — PayOnce `payable_registry_v2_1` (Concordium testnet)

**Instance: `<13152,0>` — Module: `a299ab6b6a9e056f02898b6da0c9e56eca987d5364a3cb4e3a99ab65d02a77eb`**
**Date: 2026-11-24. Work dir: `~/workspace/payonce-build/contract-v21/`. Testnet only. No git (integration lead owns the repo).**

## Verdict

**v2.1 is built, tested 83/83, deployed, matrixed 33/33 (independently re-verified 29/29), and happy-pathed ALL PASSED on testnet.** Both scoped changes work live: the F1 −18 fix (pay succeeds under the new `balance_before − amount` assertion) and F5 (`record_payment_tx` records the `pay_ccd` hash; the view shows it). **One honest limit, stated plainly:** the literal live dust drill (donate dust, then pay) cannot be executed — not because the fix fails, but because **no transaction exists that can put CCD into this contract** (§6). The dust case is proven by engine test M04; the live pay proves the new assertion at balance 0; the contract is dust-proof by construction.

## 1. What changed vs v2 (two changes only, plus tests)

| # | Change | Detail |
|---|--------|--------|
| F1 | −18 fix | `pay_ccd` no longer asserts `self_balance() == 0`. It captures `balance_before = host.self_balance()` at entry (includes the attached amount) and asserts `self_balance() == balance_before − amount` after the forward (`src/lib.rs`, `contract_pay_ccd`). A pre-existing stray balance is tolerated; the call neither creates nor loses CCD. No sweep entrypoint (D10: no admin key). |
| F5 | `record_payment_tx` | New entrypoint (15 total, was 14). The payer records the `pay_ccd` tx hash **after** finalization: `RecordPaymentTxParam { seller, payable_id, tx_hash: [u8; 32] }`. Guards, in check order: zero hash → −14 (checked before the load); missing payable → −3; PLT asset → −4 (before the status check); not Paid / already recorded → −5; non-payer → −17; contract sender → −1. Emits `PaymentTxRecorded`. Evidence-only: the contract cannot observe its own tx hash (the Concordium tx hash is sha256 over the serialization *including* the signatures, so the payer cannot know it before signing; concordium-std exposes no tx-hash accessor) — the verifier must check the recorded hash resolves to the `pay_ccd` tx. |
| — | Rename + schema | Crate/contract `payable_registry_v2_1`; `SCHEMA_VERSION` 2 → 3 (all 10 event sites emit 3). 27 rejection codes unchanged. Everything else identical to v2. |

## 2. Rust tests — 83/83 passed

`cargo concordium test` (cargo-concordium 5.0.0, rustc 1.99.0, `CARGO_NET_OFFLINE=true`): **83 passed, 0 failed, 30.05 s.** Composition: 80 v2 tests + M03 rewritten (init-with-CCD rejected + balance-preserved invariant) + M04 (F1 drill, engine half: pay succeeds with a pre-existing balance) + M05 (F5 happy path + view + event) + M06 (F5 reject matrix, check order verified). Co-signer tests 35/35 unchanged (not re-run here — untouched domain).

First run was 80 passed / 3 failed — all three were E-series event tests asserting `schema_version: 2`. The contract correctly emits 3 after the bump; the tests were updated to 3 (including renaming `e03_…_schema_version_2` → `…_schema_version_3`). No contract code changed for those failures.

## 3. Module

| | |
|---|---|
| Prefixed wasm (`payable_registry_v2_1.wasm.v1`) | 73,823 B; sha256 `a299ab6b6a9e056f02898b6da0c9e56eca987d5364a3cb4e3a99ab65d02a77eb` |
| Raw wasm (`payable_registry_v2_1.raw.wasm`, 8-byte prefix stripped) | 73,815 B; sha256 `06d5f344167d3b30a87bed2247442fb450333850b275c69b98546ef435c84ca9` |
| Deployed module ref | `a299ab6b6a9e056f02898b6da0c9e56eca987d5364a3cb4e3a99ab65d02a77eb` (= prefixed sha256) |

## 4. Deploy (testnet)

| | |
|---|---|
| Module deploy tx | `c986439093f28567aa80e82b2791a5e0d97202ce472b8973bbbc8b82b43afcf6` — finalized 7.2 s, energy 81,365, cost 631,753,567 microCCD (631.75 CCD) |
| Init tx | `99a826e64611c6ccacdf4303504451895c93ac9254ad8217bcfaa7d2a784ff27` — finalized 6.8 s, energy 1,064, cost 8,261,363 microCCD (8.26 CCD); `init_payable_registry_v2_1`, amount 0, `cis8004=<12802,0>`, `reservation_secs=3600` |
| Instance | **`<13152,0>`**, owner = deployer `42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB`, 15 entrypoints, balance 0 |
| Config view (live) | `cis8004=<12802,0>`, `reservation_secs=3600` |

Deployer before: 143,581.787090 CCD, nonce 195. After deploy: 142,941.772160 CCD, nonce 197 (spend 640.01 CCD = 631.75 + 8.26, reconciles exactly).

## 5. Live matrix — 33/33 passed, independently re-verified 29/29

`scripts/matrix-v21.mjs` on `<13152,0>` (25 v2 cases + 4 new `record_payment_tx` cases + 4 view/policy entries). `scripts/verify-matrix-v21.mjs` re-read every tx from the node: **29/29 pass, all finalized, every reject code exactly as expected.** Deployer spent ~249.91 CCD over the 29 txs (nonce 197 → 226); B untouched (114.736779 CCD — no pay succeeded, as designed); contract balance 0 after.

| # | Case | Tx hash | Result |
|---|---|---|---|
| V0 | view `get_config` | — | `cis8004=<12802,0>`, `reservation_secs=3600` |
| V1 | view `get_payable(1)` pre-register | — | null |
| 1 | register P1 CCD 10 (token 1476) | `c63c28ba82dc40592f6ca8d692bd05151bc8b2ee3efd54472ded09905244174e` | SUCCESS (E 1949, 15,132,892) |
| 2 | register P1 again | `049dcd732422f7c952a99b70a12a661720867788ba566d6dd0533af9d1dbdf30` | REJECT −2 (E 773, 6,001,912) |
| 3 | register id=11 token 1261 (other owner) | `d0e5055b914483ac820fa63adb5314810d7d655dc54f57c8ca81e9c65a70c778` | REJECT −10 (E 3095, 24,030,939) |
| 4 | register id=12 token 999999 (nonexistent) | `b7796202c46787f33104bfdcd379064c3579bf77384bb45db3667d2cb197f003` | REJECT −8 (E 1368, 10,621,753) |
| 5 | register id=13 due past | `46b77a9a862b9b60455796e9483f8b2c81c1540ec9054de1cf749fec2626eecc` | REJECT −7 (E 764, 5,932,032) |
| 6 | register id=14 expected_payer=seller | `3b3a89bf3cbd944b091c9b2ecfbdd0f7e482fdf88c6b9c92368b8a15f4a0ba12` | REJECT −27 (E 796, 6,180,494) |
| 7 | register P2 CCD 5 | `620ab72cb39d13422f649bbaa090a068d1360e6547a6466dc828a1ff328ac7ab` | SUCCESS (E 1967, 15,272,652) |
| 8 | pay P2 with 4 CCD (wrong amount) | `53017b50ee9f99d94e82cabaf15e84432e47ab503537acdc70d31b64a896728f` | REJECT −6 (E 703, 5,458,401) |
| 9 | pay P2 exact 5 CCD (payer==seller) | `47d2870a3de369164ae399431e4edeabee20483d7b723c9f513f86177d79c8ad` | REJECT −27 (E 703, 5,458,401) |
| 10 | pay id=999 (not found) | `08d8bee1c0dd3204f19ced658ac567a2d3492c12efc4f69a92fb8e2e27c143ee` | REJECT −3 (E 695, 5,396,285) |
| 11 | register P3 PLT 1.00 EUDemo (expected=B) | `66bccdc73e98ccf9cfc3be22f1aba28a2716330b286d4cf3de20ea4244c4dd5a` | SUCCESS (E 2096, 16,274,264) |
| 12 | pay P3 (PLT) via pay_ccd | `c7b6d6f30d6761c6d7ebd724e92c5f6041a0365ee4ea47c166e99aa4d0f80d3c` | REJECT −4 (E 706, 5,481,694) |
| 13 | reserve P3 by deployer (not expected payer) | `b03b243513d042a82d4d9c118872d8066d907cedec721f132032130ea7c30598` | REJECT −21 (E 710, 5,512,752) |
| 14 | register PLT id=15 no expected_payer | `49bbd99ecbf8c1367a2d71b902a3c8de3f85a31c2db2b735b7d89f2289a04d8d` | REJECT −22 (E 776, 6,025,205) |
| 15a | **record P3 (PLT) → −4** | `ee0951489424a207f6381ad74a2a898db99e07b55e2a522ba7b88f6081e65c17` | REJECT −4 (E 752, 5,838,859) |
| 15b | **record P1 (Unpaid) → −5** | `1a1433899229bb3e17fee1e80947731197213e5c664c10287009620af8cc813f` | REJECT −5 (E 750, 5,823,330) |
| 15c | **record id=999 (missing) → −3** | `7035c1b5bcd9a6e1a20d3273de69f00c4ed66eac8e62d6fa6958463fc8c3157e` | REJECT −3 (E 741, 5,753,450) |
| 15d | **record id=999 zero hash → −14** | `99095698b776895f6d8209c85f30c1fc44674c2cfbd30fc794c177b436e7550c` | REJECT −14 (E 739, 5,737,921) |
| 16 | approve_vendor seller==buyer | `eff7a815070e9c5b1ebdc051e2d51012cc34c615783cb2571c4f51c8f4ccfd2d` | REJECT −27 (E 753, 5,846,623) |
| 17 | approve_vendor seller=B | `326a279d7415fe4908b3ed6ef3c69caf94353c2435c7aeb19ca8d64cf9d93201` | SUCCESS (E 1285, 9,977,304) |
| 18 | revoke_vendor seller=B | `c249695e88dc16ba4398fe01b5ece7c252f29fb77b6c7d907979629e51b214f9` | SUCCESS (E 908, 7,050,111) |
| 19 | set_strict(true) / set_strict(false) | `ab12bcdd32f83258f36006db96774dc076162baeb77b3284845e334df2462887` / `b27065473879e43813cd2c5138c58c593ea889241e14bf1ccafd6ec94e664c6a` | SUCCESS / SUCCESS (E 958/953) |
| 20 | register P4 CCD 1 | `9a904cdf02d8adef340511234fd11b82a11df023a4ecdd343bfdffeb25fcbb08` | SUCCESS (E 1979, 15,365,825) |
| 21 | void P4 | `c32adbd90a2fd2156fcf0a2aee59e8bd4a5fcb9396bd11b9c793c2d3063a2b40` | SUCCESS (E 1197, 9,294,034) |
| 22 | pay voided P4 | `244e0fac816be9e576f33db10f9f09620975347f8c1949c57af1d8be5441b148` | REJECT −25 (E 703, 5,458,401) |
| 23 | void P4 again | `07fbd39b55844ac8d886445b6d1a57afff4a6af28c7cadbdcf2aef47ce915320` | REJECT −5 (E 676, 5,248,761) |
| 24 | register P5 CCD 1 due+8s | `0ef5130510b5aca72af1032c8d380d3d5b91c9f4df561649796380ec0b842d8b` | SUCCESS (E 1988, 15,435,705) |
| 25 | pay P5 after due | `c80831310304374f4eef1c18226fbd505f6f4115cbcf2e1b5cc6f88fa36660b9` | REJECT −7 (E 703, 5,458,401) |

Final views: P1/P2/P3/P5 Unpaid, P4 Voided. (Energy/cost in microCCD.)

## 6. The dust drill — what was found instead (read this before judging F1)

**The literal drill (donate dust, then pay) is impossible on v2.1 — by construction, through three independent barriers, each verified:**

1. **A plain CCD transfer cannot target a contract.** The SDK serializes `AccountAddress.toBuffer(transfer.toAddress)` (`SimpleTransferHandler.serialize`); a `ContractAddress` has no 32-byte buffer, so the SDK throws before anything is sent. The Concordium `Transfer` recipient is a 32-byte account address at the protocol level too. (My first two happy-path runs crashed exactly here — a script bug in my assumption, not a contract bug.)
2. **An update with attached CCD to any non-payable entrypoint is rejected by the chain.** Only `pay_ccd` carries the `payable` marker in `src/lib.rs` (line 794); all 14 other entrypoints — including new `record_payment_tx` — lack it, and init is not payable. Proven live: `record_payment_tx` on Unpaid p10 with 1,000 microCCD attached → tx `90cc8c30cf00520694ee7b33d94523ff631b5760d456b64bd6a555767ed15ceb`, finalized, **RejectedReceive −2147483636** (a chain-level code, outside the contract's −1..−27 range; energy 730, cost 5,668,041 microCCD). Contract balance stayed 0.
3. **`pay_ccd` forwards exactly the attached amount** and requires it to equal the payable amount, so nothing can stick there either. (And `invoke_transfer` takes `&AccountAddress` only — a contract cannot plain-transfer to another contract.)

**Consequence:** the contract cannot hold dust at all — the −18 scenario is unreachable live. The −18 fix remains correct as defense-in-depth (the new assertion holds for *any* `balance_before`, however it might arise), the dust case itself is proven by engine test M04, and the live pay below proves the new assertion executes successfully at balance 0. What is NOT proven live is the dust case — because it cannot occur live. This is a finding about the drill premise, not a failure of the fix. The F1 evidence for the judge is therefore: M04 (engine) + the live attached-CCD rejection + the live pay under the new assertion — not a donated-dust pay.

## 7. Live happy path — ALL PASSED

Roles (mirrored, same documented reason as the v2 run): seller = owner `42jaZZ…` (the only account with an agent token on the official CIS-8004 `<12802,0>`, token 1476, Active); payer = B `4MvdMEGC…` (HD-derived key, identity 1 counter 1 — derivation re-verified live against the chain's verifyKeys: **match**). B owns no official-registry agent token, so B cannot register (would fail −10); D6 (B onboarding) stays an open user step. Payee CCD = payee1 `4gedLUop…`; payee PLT = payee2 `4Vtd6WnC…`. Energy cap 6000 NRG for B's sends (v2 lesson: the node requires balance ≥ maxEnergy × rate).

| Step | Tx hash | Result |
|---|---|---|
| approve_vendor B→owner tier 2 (legal hash) | `99b6278ad6d54649cc7bb1a439d25d5587c63f5e48896889dcf363d3aeab8119` | SUCCESS (E 1294, 10,047,184) |
| **approval fix** — re-approve legal=null (see §8) | `1179dd356a03ffabfb605f30d14b6a0a733e8b11faa79826a6a8a3be79176796` | SUCCESS (E 1198, 9,301,798) |
| register p10 CCD 0.5 (expected=B, legal=null) | `c42c0581e8a90c22ab9af00289c0176d76313ebbf90b763e0ca0fc5e6715880d` | SUCCESS (E 2106, 16,351,909) |
| attached-CCD probe (see §6) | `90cc8c30cf00520694ee7b33d94523ff631b5760d456b64bd6a555767ed15ceb` | REJECT −2147483636 (E 730, 5,668,041) |
| **pay_ccd p10 by B (0.5 CCD)** | `d0f30224c57f811b53c5ddf11a4cdbb45e0f8fbd78d30b38397c255b9952919e` | **SUCCESS (E 2521, 19,574,151)** — balance after pay = 0 == balance_before; payee1 +500,000 microCCD exactly |
| record p10 by OWNER (not payer) | `6e5a358d39166c3a09ddcee1c66535a79d96c584da1b851e7f0e4cec69643f9e` | REJECT −17 (E 751, 5,831,094) |
| record p10 zero hash by B | `e16a7032dfeb17ba0a56464876cb970de19fe03f4e23fe35206a93221ae07923` | REJECT −14 (E 739, 5,737,921) |
| **record p10 pay hash by B** | `a3ae4f704d4b6c96760217a92d97ce3930abb9e670ea3459a63d1d13af370f11` | **SUCCESS (E 1489, 11,561,250)** — view txHash == pay hash: **true** |
| record p10 again by B | `054d7689099b6cef348deabc31d25050b2f344d8926e48f77360cb678135541a` | REJECT −5 (E 754, 5,854,387) |
| register p11 PLT 0.01 EUDemo (expected=B) | `e29f5be831d3906ce9b68e43d27db63c072e3fb98ee012d2d4536e1205114f69` | SUCCESS (E 2159, 16,763,424) |
| reserve p11 by B | `183a8379c8757c21fad47060f6b3d9136e849b091a68ffde4b33ccba20bd8cc2` | SUCCESS (E 2244, 17,423,401) |
| EUDemo transfer B→payee2 0.01, memo `payable:42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:11` | `880dcdd4f42ef4b6ec2b36a8a2d9383e7c6390dfbbef9f6dac1f8f5705604d2a` | finalized (E 727, 5,644,748) |
| confirm p11 by B | `dc87e2eaaebb5d50c73ef46032f5b22349e8e4a56aec57231a1270bdbf20ca91` | **SUCCESS (E 1666, 12,935,556)** — view txHash == transfer hash: **true**; payee2 EUDemo +10,000 exactly |

Final views (independently re-read from the node after the run): **p10 Paid, payer=B, txHash=`d0f30224c57f811b…`**; **p11 Paid, payer=B, txHash=`880dcdd4f42ef4b6…`**; contract balance **0 microCCD**; p12–p15 absent; p1–p5 exactly as the matrix left them. Balances reconcile: payee1 158,583,844 → 159,083,844 (+500,000 exactly); payee2 EUDemo 100,100,000 → 100,110,000 (+10,000 exactly); B EUDemo 207,360,000 → 207,350,000 (−10,000 exactly). (Owner/B CCD moved by more than this run's fees because the API worker's smoke test runs in parallel on the same accounts — see §9; the asserted deltas are the payee deltas, which are exact.)

## 8. Two failures on the way (both mine, both fixed, both recorded)

1. **Dust-donation crash (runs 1–2).** I assumed a plain transfer could target the contract. It cannot (§6.1). Fixed by replacing the donation with the dust-proofness proof (§6.2 + live pay). No chain state was harmed: both runs crashed before any dust send; approve + register from run 1 were reused on resume.
2. **Pay rejected −20 (run 3).** My run-1 approve carried `legal=sha('company-legal-ref')` while p10 registers with `legal=null`; `check_legal_ref` (byte-identical in v2 and v2.1 — verified by diff) correctly refused: pay tx `c893a253eaff1192cd84d611b5548903ff2eff89f9b34a942a8eac6c5e9d63c5`, RejectedReceive −20, energy 714, cost 5,543,810. Not a contract bug. Fixed by re-approving with `legal=null` (approve_vendor overwrites the row — plain insert, verified in source); the next pay succeeded. The v2 run used `legal=null` on both sides.

## 9. Parallel activity on the same accounts (solved, not a security issue)

During my runs, B's nonce jumped (73 → 79 → 87 → 95) and the owner funded B (+500 CCD, tx `05a66c3f8995e44b7ff7e47eebc6a1dda6f851312a8dee85de74f6eb325e3294`), payee1 gained +1.0 CCD and payee2 +0.02 EUDemo — all outside my scripts. Cause, confirmed from the sibling worker's own report: the **API-server worker's `npm run smoke`** — a documented full live E2E with real sends against the default contract v2 `<13150,0>` (fresh payables #1001–#1004, CCD + EUDemo pays). It runs in parallel on the same accounts by design. My v2.1 state is verified untouched (scan above). The API worker also noted nonce contention with my worker in its report.

## 10. My own error (disclosed)

While probing p10 I ran `node -e "import('./matrix-v21.mjs')"` — which re-executed the whole matrix. I killed it after ~2 min; it had sent ~23 deployer txs (owner nonce 226 → 250, ~340 CCD in fees) before the kill. It did **not** overwrite `matrix-v21-result.json` (the script writes only at the end) and touched only ids 1–5/11–15, never p10/p11. The verified 29/29 matrix result stands. The duplicate run's cost is included in the owner balance walk (142,691.87 → 141,915.65 across the whole session, with deploy + matrix + happy path + smoke-test funding interleaved).

## 11. Files (for the paired judge)

- Contract + tests: `~/workspace/payonce-build/contract-v21/payable_registry_v2_1/` (`src/lib.rs`, `tests/payable_v2_1.rs`, `payable_registry_v2_1.wasm.v1`, `payable_registry_v2_1.raw.wasm`)
- Scripts: `~/workspace/payonce-build/contract-v21/scripts/` — `deploy-v21.mjs`, `matrix-v21.mjs`, `verify-matrix-v21.mjs`, `happy-path-v21.mjs` (with resume logic; the impossible plain-transfer helper was removed, with the reason in a comment), `probe-v21.mjs`, `check-live-v21.mjs`, `scan-v21.mjs`
- Evidence: `deploy-v21-result.json`, `matrix-v21-result.json`, `matrix-v21-verified.json`, `happy-path-v21-result.json`
- This report: `~/workspace/payonce-build/contract-v21/CONTRACT_V21_REPORT.md`

Reproduce: `cargo concordium test` in the contract dir (83/83); `node matrix-v21.mjs` + `node verify-matrix-v21.mjs` (read-only re-verification needs no sends); `node happy-path-v21.mjs` resumes from the evidence file (approve/register/probe skipped once passed). No secrets are printed by any script; keys load in-process only from the concordium `.env`.
