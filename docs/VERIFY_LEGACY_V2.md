> **Legacy.** This is the v1/v2-era guide, kept for the record (the older Run-it page and the v2 registry `<13150,0>`). The current guide, for v3 and Verification of Payee, is [`VERIFY.md`](../VERIFY.md).

# PayOnce — judge verification guide

Verify every claim from the chain alone. No keys, no backend, no trust in us.
All hashes below are Concordium **testnet** (genesis
`4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`).
Paste any hash into the search box on the testnet CCDExplorer, or check it with
the commands below.

## 1. The contract

- Instance: **`<13149,0>`** (v1 registry), module
  `9b5b27fa7e6d4f40b5a94563b396d8760e2c6eca90eefa91949859be7ae71d24`.
- **v2: `<13150,0>`**, module
  `c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8`,
  14 entrypoints, config `cis8004=<12802,0>`, `reservation_secs=3600`.
  Deploy tx `edb6d1af6166f3e17fe4623c1af85d41bc2020b09d8773a380be8e018dc6e5f3`,
  init tx `50d007af74c64a20d280afff20276c49e379188c764564a43695cbce2370ee50`.
  Full 25-tx live matrix (10 successes + 15 rejects, exact codes) with
  hashes: `contracts/CONTRACT_REPORT.md` §4 — re-read it yourself with
  `node contracts/scripts/verify-matrix.mjs` (read-only, no re-sends).
- Balance: **0** after every step (asserted by the Rust tests and by the
  verifier). The contract never holds funds across transactions; each CCD
  payment is forwarded in the same transaction.
- The seller agent is cross-checked against the **official** CIS-8004
  registry `<12802,0>` at registration and at payment, failing closed
  (seller tokens 1476 and 1506; the payer agent is token 1488). The v1
  registry was rehearsed against our own instance `<13144,0>`; the deployed
  v2 uses the official one.

Check a payment on the **deployed v2** (read-only, no keys). The verifier
is `api/src/verify-payable-v2.mjs`; run it from `api/` after `npm ci` in
`backend/` and `api/`:

```sh
cd backend && npm ci && cd ../api && npm ci
node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt
# expected: ALL CHECKS PASS (10/10), incl. "agent token 1476 on <12802,0>: owner matches seller, status Active"
```

The older v1 verifier is `backend/src/verifier/verify-payable.mjs` (12 CCD /
15 PLT checks, incl. the F10 binding — see `backend/BACKEND_REPORT.md` §2).
It checks v1 payables. Run it from `backend/`:

```sh
cd backend && npm ci
node src/verifier/verify-payable.mjs 6 828ebd253b02626bb470169bbce114691f16d55d560ed9750df197d1198e875a --rail ccd --doc test/invoices/invoice-006-ccd.txt
# expected: ALL CHECKS PASS (12/12) — payable 6, Rail A
```

(The older `services/verify-payable.mjs` is superseded: it does not run
from a fresh clone — no root dependencies and no `services/out/deploy.json`
in the repo. Use the backend verifier above.)

## 2. Rail A (CCD) — the contract *is* the payment

**v1 (superseded — the deployed registry is v2 `<13150,0>`):**

| What | Transaction | Expected |
|---|---|---|
| Payable stored as structured on-chain fields; seller agent cross-called (Active, owner = seller) | `d898683668cd8d55fdb2c0ab2505c2d547e137b7955e131b8863d82ad01efb2d` | Finalized |
| `pay_ccd` forwards 500,000 microCCD to the stored payee in the same tx | `00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6` | Finalized; verifier 10/10 |
| Second payment reverts (-5), money does not move | `a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848` | Rejected |
| Wrong amount reverts (-6) | `52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c` | Rejected |
| Unknown id reverts (-3) | `d906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28` | Rejected |

**v2 (deployed — `<13150,0>`, live on the deployed stack):**

| What | Transaction | Expected |
|---|---|---|
| Payable 10 registered (CCD 0.5, payee1) | `e36da695159bfb809d96b732c9d056cead0ccf357e4a2a763ccc801625b606f9` | Finalized |
| `pay_ccd` forwards 500,000 microCCD to the stored payee in the same tx | `7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197` | Finalized; verifier 10/10 |
| Second payment reverts (-5), money does not move | `7d37ec8e82fdc02192ffa3d14f794174fbf8ceee849f5bdb28b107b84199dd72` | Rejected |
| Wrong amount reverts (-6) | `a5e6c6b2589b5dfd89e7c59b54e36ceec232f2bb6fc961cf37a4ee96f2dfc584` | Rejected |
| Payable 1005 created + paid on the deployed stack (register) | `e7e62bf6f99f99c2cda51c2c273ba129168248bbeef414690a1923c05509d002` | Finalized |
| Payable 1005 paid live via the UI (0.5 CCD, fee 21.182163 CCD) | `244949231ace2927d3466263aad3dba9996fab7ca8b94e12be8943205ce5326d` | Finalized; verifier 10/10 |

The verifier binds the transaction to the payable id (it reads the `pay_ccd`
parameter and the contract's `Paid` event). Proof: checking payable 1
against the transaction of payable 4 **fails**, as it must:

```sh
cd backend
node src/verifier/verify-payable.mjs 1 78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e --rail ccd
# expected: FAIL on CCD-04 (parameter id=4, requested=1) and CCD-05 (Paid event id=4), exit 1
```

## 3. Rail B (EUDemo) — the guard precedes the payment

**v1 (superseded — the deployed registry is v2 `<13150,0>`):**

| What | Transaction | Expected |
|---|---|---|
| `reserve_plt` by the 2-of-3 agent account (sponsored) | `ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1` | Finalized |
| Co-signed 0.01 EUDemo to the stored payee, memo `payable:2` | `7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef` | Finalized; verifier 14/14 (doc skipped) |
| Second reservation while reserved reverts (-16) | `ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35` | Rejected |
| Confirm by seller, linking the EUDemo hash | `212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde` | Finalized |
| Reused tx hash rejected (-12) | `02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b` | Rejected |
| Stranger confirm rejected (-17) | `8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a` | Rejected |
| Early expiry rejected (-13) | `8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7` | Rejected |
| Expiry by a third party after the window | `492607926c88c3d9bdcad4edaebd8298c48668d7ee22a0d367cf74b6cdba0760` | Finalized |

**v2 (deployed — `<13150,0>`, live on the deployed stack):**

| What | Transaction | Expected |
|---|---|---|
| Payable 11 registered (EUDemo 0.01, payee2) | `129f8943fd5c8a08241fe608899792acde712fe1ae3d9ee1d0eb067d2a790851` | Finalized |
| `reserve_plt` (window exactly 3600 s) | `a36aa1e0d2ea71a4702075cd0d94752fac7f088dfb52d4038322b7e617180f0d` | Finalized |
| Co-signed 0.01 EUDemo to the stored payee, memo `payable:<owner>:11` | `690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214` | Finalized; verifier 14/14 (API after_pay EUDemo run) |
| `confirm_plt`, tx hash pinned (PltConfirmed) | `adf55f61c1345d14f05c6c0ee59b996dae8aaef06213e485a17cfb96376100c2` | Finalized |

```sh
cd backend
node src/verifier/verify-payable.mjs 2 7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef --rail plt --reserve-tx ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1 --confirm-tx 212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde
# expected: ALL CHECKS PASS (14/14, 1 skipped — no doc supplied) — payable 2, Rail B
# with --doc: payable 11 (MCP-paid) is the 15/15 reference run, see backend/BACKEND_REPORT.md §3
```

The agent key alone cannot move funds: the node rejects an agent-only
transfer ("Verification failed"). The co-signer refuses wrong payee, wrong
amount, wrong or missing memo, unreserved payables, and re-reserves (its
decision table is `contracts/cosigner/test/` — 35 cases).

## 4. Run the tests yourself

```sh
# Contract (v1: 26 tests; v2: 80 tests incl. the full 27-code reject matrix)
cd contracts/payable_registry && cargo test --release
cd contracts/payable_registry_v2 && cargo concordium test   # 80 tests (Chain engine)

# Co-signer decision table (35 cases)
node --test contracts/cosigner/test/decide.test.mjs

# Backend (110 tests: verifier negatives, co-signer decide + server,
# facilitator, invoice adapter, receipts, EasyPost, MCP)
cd backend && npm ci && node --test test/*.test.mjs

# Frontend
cd frontend && npm ci && npm run build && npm test
```

Two clean builds of the v2 wasm must give the same sha256 — not yet done
(see §6). The deployed module hash matches this single build's `.wasm.v1`
sha256 exactly (`contracts/CONTRACT_REPORT.md` §3).

## 5. What "try to break it" shows

On the dashboard, five attacks each name the layer that refuses them:

1. Pay the same payable twice → **Chain** refuses (-5).
2. Pay a fraudster's payable (seller not on the buyer's vendor list) →
   **Co-signer** refuses (live dry run: `no-approval`). Strict vendor-list
   mode is on by default. **Chain** refuses (-19) on the EUDemo rail
   (`reserve_plt` always needs an approval row). On the CCD rail the chain
   refuses (-19) when the buyer's on-chain strict flag (`set_strict`) is
   on. It was switched on (testnet tx
   `0076d6f9529aeafa89797682f4f43c8b56af330741536afac7176e27b99148d9`).
   Live proof: with seller 2 temporarily revoked from the buyer's vendor
   list (tx `5d62e9fe8549111cbf069c3306d97992e4162ad4becd149a644876c766acc236`),
   `pay_ccd` for payable 5003 reverted with -19 (tx
   `e8e3d588817c80f58d20589752bf72f61896f8430e95bd880f9b06c6647688b5`);
   seller 2 was re-approved with the same caps (tx
   `f18cf4f6dc799b0f445cc984e992a87515b4c331a302373412494ec7e3a2bffa`); and a
   payment to listed seller 1 (payable 1461) still succeeded (tx
   `adfc7de2f5d1834687324119a12206562787ef3a6b4cb5a1972f41ef29f5bc23`).
   The API also refuses before signing (`vendor-gate`). `GET /api/config`
   shows both (`build.ccd_rail_vendor_gate`, `build.ccd_on_chain_strict`). No fraud
   payable exists on this registry to try live.
3. Confirm with a junk hash → **Chain** refuses (-12/-17).
4. Pay after the reservation window → **Chain** refuses (-24).
5. Agent key alone tries to move funds → **the node** rejects it.

## 6. Known limits (honest — read before judging)

- **v2 success path is now proven live on chain.** The v2 contract
  `<13150,0>` is deployed, its 25-tx matrix is live (10 successes + 15
  rejects), AND the 8-tx happy path ran live 2026-11-24 ~08:36–08:38 UTC:
  fund B → approve_vendor → register + pay_ccd payable 10 (CCD 0.5, paid
  by B) → register + reserve_plt + co-signed transfer + confirm_plt
  payable 11 (EUDemo 0.01) — all 3 co-signer gates SIGN, views + balance
  deltas verified (see `backend/BACKEND_REPORT.md` §6; the backend judge
  re-read all 8 txs). Roles are MIRRORED (seller = owner, payer = B)
  because B owns no agent token on the official registry `<12802,0>` —
  that is the open D6 item (a seller-direction gap, not a
  payment-mechanics gap): a seller who is not the deployer registering on
  v2 is not yet proven.
- **v2 `pay_ccd` does not record its own tx hash in the view — fixed in
  v2.1.** The v2 contract records the transfer hash only on the PLT path
  (`PltConfirmed`); the (owner,10) view on v2 shows `txHash: null`. A receipt
  built from the v2 view alone cannot pin the CCD payment tx — the verifier
  re-derives it from the supplied tx, so nothing is broken. **v2.1
  `<13152,0>` closes this:** the new `record_payment_tx` entrypoint stores
  the pay hash in the view, verified live — the p10 view's `txHash` is
  `d0f30224…`, re-read as the `pay_ccd` call (payer B, 0.5 CCD, exactly
  500,000 microCCD to payee1); the p11 view holds `880dcdd4…`, the EUDemo
  transfer. A receipt built from the v2.1 view pins the payment tx.
- **−18 stray-balance griefing (v2) — CLOSED by the v2.1 redeploy, with a
  corrected severity.** The v2 judgment's premise ("a direct CCD donation
  to `<13150,0>` would brick every later `pay_ccd`") was WRONG: the
  griefing vector was **never live-exploitable** — no transaction exists
  that can put CCD into the contract (the SDK's transfer serialization
  throws for a contract address; an update with attached CCD to a
  non-payable entrypoint is chain-rejected — live probe `90cc8c30…` →
  RejectedReceive −2147483636, balance stayed 0; `pay_ccd` forwards
  exactly). The v2.1 fix (assert `self_balance() == balance_before`
  instead of `== 0`) is therefore **defense-in-depth for an unreachable
  balance**, not the closure of a live vulnerability — and it works live:
  the pay succeeds under the new assertion at balance 0, the dust case is
  proven by engine test M04. The same flaw exists in v1 `<13149,0>`.
  A sweep entrypoint is rejected (no admin key).
- **Two-clean-builds reproducibility — CLOSED for v2.1, still open for v2.**
  The v2.1 judge's independent clean rebuild produced the same wasm sha256
  (`a299ab6b…`) as the deployed module; the merge lead's own clean build
  matched it too (a third build). For v2 the deployed module hash matches
  this single build's `.wasm.v1` sha256 exactly, but the two-clean-builds
  check was not run. A verifiable build is blocked (no Docker on the
  build VM).
- **Badges.** The sellers (1476, 1506) and the payer (1488) are registered
  on the official `<12802,0>` with agent cards hosted on the site
  (`frontend/public/.well-known/`, served byte-stable; the card's SHA-256 is
  the on-chain metadata hash). The site prints "Verified by Concordium" only
  from a live call to the registry's badge-check that returns
  `badge_valid: true` (see §7). Not done: a CIS-8 external-key binding (no
  external key is held), and a company identity (no LEI).
- **The euro rail is co-signer-bound.** Contracts on Concordium can move
  CCD only, never PLTs. On Rail B the guard precedes the payment (2-of-3
  node enforcement + deterministic co-signer over on-chain reservation
  state); it is not an atomic on-chain payment. The honest line is "the
  guard precedes the payment, enforced by a key holder" — not "the chain
  refuses" (that phrase is used only for real on-chain reverts).
- **"Never pays a fake invoice" is not an on-chain claim.** A buyer who
  approves a fraudster can still be defrauded; the chain records who
  approved whom and caps the loss. The guarantee is: each payable is paid
  at most once, exactly, to the payee its issuer stored.
- **The seller company check runs in the verifier, not in the contract** —
  contracts cannot verify V&A proofs.
- **The v2.1 flip is blocked on the API server, not on the contract.**
  v2.1 `<13152,0>` is live and verified, but the deploy target stays v2
  `<13150,0>` until the API server's v2.1-switch fix lands and is
  re-verified on v2.1: the server's "switchable with no code change" claim
  is false as documented — the contract name defaults to
  `payable_registry_v2` while v2.1's on-chain name is
  `payable_registry_v2_1` (the documented switch 500s every payable read),
  and payment-tx/document resolution is v2-scoped (on v2.1 it served the
  v2 pay tx `7c204f0b…` instead of the v2.1 view's `txHash d0f30224…`;
  verify after_pay blocked 5/10). The fix: document all three switch
  knobs (INDEX, MODULE, NAME) + fail fast at startup if the configured
  name/module doesn't match the on-chain instance + registry-scope the
  resolution (prefer the view's `txHash` when present) + re-verify on v2.1
  (payable 10 returns `d0f30224…`, verify 10/10, receipt 10/10).
- **The accountable human is a testnet identity.** The owner proof (§7) is
  from the Concordium testnet identity provider with test attribute values.
  The verifier that anchored it is a PayOnce lab account, so owner and
  verifier are one operator: it shows the mechanism, not an independent KYC.
  Seller 2's owner has no proof (the verifier-side check refused its
  credential).
- **Trust model.** One testnet seed on the API host derives the owner, seller
  2, the payer and the sponsor. The co-signer is a decision gate in the same
  process. See `/app/judges#trust`.
- **x402.** The hosted facilitator answered `/settle` with "not found" while
  the chain had confirmed the transfer (§7).
- **Ceiling.** The independent assessment of this idea family is ≈ 9.0 on
  the idea lens, set by the CCD-only atomicity above. This repo maximises
  within that ceiling and claims nothing beyond it.

## 7. Identity, owner proof and x402 (checked live)

```sh
# Badges on the official registry (expected: "badge_valid":true, status Active, issues [])
curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a?network=testnet"   # seller 1, token 1476
curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9Y9nGU4KaM7DBDXRgm?network=testnet"   # seller 2, token 1506
curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9Xp5bhbLsQrw7yTyph?network=testnet"   # payer, token 1488

# Owner proof (Verify and Access V1, 18+ and EU), re-checked from the published record and the node
cd backend && npm ci
node scripts/verify-owner-proof.mjs https://payonce-tau.vercel.app/proofs/owner-proof.json
# expected: ALL CHECKS PASS (8/8)

# x402 settle through the hosted facilitator, payable 97592
# expected: ALL RUNNABLE CHECKS PASS (13/14). The recorded run had the invoice file (14/14); that file was not kept,
# so a fresh run reports the document check as "not run", never as passed.
cd ../api && node src/verify-payable-v2.mjs 97592 3bf4d852ed62247a3e5c0473749198b833b190a16b84be5a20d19c9c8ef3de2b --reserve 314ead1bf99162982a5d37f29cca711be0715d5fda16026a83bac64178b89042 --confirm a7be41de6ca6694fb6abdb3dc6a007ddd674c73f2e5ff51ffbab41ab3d678854
```

- Owner proof anchors: VRA `066618a0f8be6a8d869a921305caa67430a4e3d2c16ace2ccae46d5fe5918a73`,
  VAA `7c0b3b47bb51f8d4cbdec66a4efd29d6d7b0d5f86f7664dfec5a72b15e2d1c7a`
  (record: `frontend/public/proofs/owner-proof.json`).
- x402 receipt page: `/app/x402`; raw record
  `backend/test/x402-hosted-settle-2026-11-26.json`. The hosted `/settle`
  returned `finalization_failed: transaction not found` while the transfer
  `3bf4d852…de2b` was already finalized; trust the transaction, not that
  answer.
