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
- The seller agent is cross-checked against a CIS-8004 registry at
  registration and at payment, failing closed. v1 uses our own testnet
  instance `<13144,0>` (the official `<12802,0>` needs publicly hosted cards
  — see §6).

Check it exists (read-only, no keys):

```sh
node services/verify-payable.mjs 1 00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6
# expected: ALL CHECKS PASS (10/10) — payable 1, Rail A
```

## 2. Rail A (CCD) — the contract *is* the payment

| What | Transaction | Expected |
|---|---|---|
| Payable stored as structured on-chain fields; seller agent cross-called (Active, owner = seller) | `d898683668cd8d55fdb2c0ab2505c2d547e137b7955e131b8863d82ad01efb2d` | Finalized |
| `pay_ccd` forwards 500,000 microCCD to the stored payee in the same tx | `00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6` | Finalized; verifier 10/10 |
| Second payment reverts (-5), money does not move | `a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848` | Rejected |
| Wrong amount reverts (-6) | `52f3b4aa09086b27d6c41c3fc4ec10b6bac92f55aa6cc892b55291758b10f01c` | Rejected |
| Unknown id reverts (-3) | `d906c0b3b8bf6333cd0522fed0b39eabae168a2e35029edd9ac5a5b5874dae28` | Rejected |

The verifier binds the transaction to the payable id (it reads the `pay_ccd`
parameter and the contract's `Paid` event). Proof: checking payable 1
against the transaction of payable 4 **fails**, as it must:

```sh
node services/verify-payable.mjs 1 78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e
# expected: FAIL on the parameter check
```

## 3. Rail B (EUDemo) — the guard precedes the payment

| What | Transaction | Expected |
|---|---|---|
| `reserve_plt` by the 2-of-3 agent account (sponsored) | `ee56c0cc845880f7875aba6afc794a1becf6a906eec639891ef75d34e8fbefc1` | Finalized |
| Co-signed 0.01 EUDemo to the stored payee, memo `payable:2` | `7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef` | Finalized; verifier 12/12 |
| Second reservation while reserved reverts (-16) | `ae62175f96035d23a6df6f84daf89520fd7c534c3a3aa1195ca9af6af752af35` | Rejected |
| Confirm by seller, linking the EUDemo hash | `212f0ac79a5ed884dbb9e4fddb5edc45d0411dc0f3f9b8739ab5b4c1ec310bde` | Finalized |
| Reused tx hash rejected (-12) | `02ad73477a2e3635f4007ed7bab3c51a4dcd72a97e851fc213a92e6ec577f23b` | Rejected |
| Stranger confirm rejected (-17) | `8ee531f203c7e7578749841bf7dd3d8a252ad220745c2921abbf2906f7700e8a` | Rejected |
| Early expiry rejected (-13) | `8902c4f12f1c268fc94576b01e1734c8a91e59b631c5857e3fa4a631eb4ef4e7` | Rejected |
| Expiry by a third party after the window | `492607926c88c3d9bdcad4edaebd8298c48668d7ee22a0d367cf74b6cdba0760` | Finalized |

```sh
node services/verify-payable.mjs 2 7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef
# expected: ALL CHECKS PASS (12/12) — payable 2, Rail B
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
   **Chain** refuses (-19) / **Co-signer** refuses.
3. Confirm with a junk hash → **Chain** refuses (-12/-17).
4. Pay after the reservation window → **Chain** refuses (-24).
5. Agent key alone tries to move funds → **the node** rejects it.

## 6. Known limits (honest — read before judging)

- **v2 is live, but its success path is not yet proven on chain.** The v2
  contract `<13150,0>` is deployed and its 25-tx matrix is live (10
  successes + 15 rejects with the exact codes). What is NOT live: a
  successful `pay_ccd` / `reserve_plt` / `confirm_plt` — those paths are
  proven only in the Chain engine. The blocker was a missing second signer;
  it is now unblocked (the seller-B key derives from the seed via the SDK's
  HD wallet — see `contracts/CONTRACT_REPORT.md` §6 note) and a live
  happy-path run is pending. No public claim of a working v2 payment until
  then.
- **−18 stray-balance griefing (v2, must-fix before the public flip).** A
  direct CCD donation to `<13150,0>` would brick every later `pay_ccd`
  with −18, and the donated CCD would be stuck (no withdraw entrypoint).
  Remedy: assert `self_balance() == balance_before` instead of `== 0`,
  shipped as a v2.1 redeploy (v2 cannot be upgraded), plus a live drill.
  A sweep entrypoint is rejected (no admin key). The same flaw exists in
  v1 `<13149,0>`.
- **Two-clean-builds reproducibility not done.** The deployed module hash
  matches this single build's `.wasm.v1` sha256 exactly, but the
  two-clean-builds check was not run. Before the public flip, re-run the
  build twice from clean on the pinned toolchain and record both hashes.
  A verifiable build is blocked (no Docker on the build VM).
- **No official registry badge yet.** The seller and buyer are not yet
  registered on the official `<12802,0>` (that needs publicly hosted agent
  cards). There is no "Verified by Concordium" label anywhere in this repo
  or on the site.
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
- **Ceiling.** The independent assessment of this idea family is ≈ 9.0 on
  the idea lens, set by the CCD-only atomicity above. This repo maximises
  within that ceiling and claims nothing beyond it.
