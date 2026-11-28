# Verify PayOnce yourself (v3, Verification of Payee)

Concordium **testnet** only (genesis `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`). Every claim has a command or a hash. Needs Node 22+.
No keys, no trust in us: the commands read public nodes, the public registry and our public API, and the ones that matter re-derive the answer from the chain.
The older v1/v2 guide is [docs/VERIFY_LEGACY_V2.md](docs/VERIFY_LEGACY_V2.md) (v2 `<13150,0>` is superseded and is not a verified build).

```sh
git clone https://github.com/mohamedwael201193/payonce && cd payonce
(cd backend && npm ci) && (cd api && npm ci)
```

## 0. Everything at once: 30 live claims (HTTP only)

```sh
node tools/census/check-live.mjs          # exit 0 only if every claim passes; add --json for a machine-readable record
```

Each line is `PASS`/`FAIL`, a claim and the evidence it read. It covers: app and API up (L1-L2); v3 `<13172,0>` and the four verdicts (L3-L5); a finalized payment and a chain refusal (L6-L7);
the 18+ anchors (L8); the 4 badges (L9, L16); stats and census (L10-L13); npm and the official MCP Registry (L14-L15); the receipt ledger (L17); x402 sales (L18-L19);
A2A (L20-L21); signed approvals (L22); the red team and the false-green benchmark (L23-L24); the spend mandate and the two-way gate (L25-L28); the standalone Action (L29); the CI test count (L30).
It only needs HTTPS, so it runs where gRPC is blocked. The public wallet-proxy and registry sometimes answer 429 or 5xx: run it again.

## 1. The contract: payee book v3 on a verifiable build

| What | Value |
|---|---|
| Module | [`8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946`](https://ccdexplorer.io/testnet/module/8641046eb939a5693731b6d79b227a1a4b356d8cf10308baabca0a93a16b3946) (CCDExplorer: Verified) |
| Live payee book | [`<13172,0>`](https://ccdexplorer.io/testnet/instance/13172/0), cooling-off **600 s** (a production book would be 24 h or more, set at init) |
| Demo book | [`<13173,0>`](https://ccdexplorer.io/testnet/instance/13173/0), cooling-off **90 s** so a visitor can watch it mature; same module |
| Registry the books cross-check | official CIS-8004 `<12802,0>` |
| Superseded | v2 `<13150,0>`, v1 `<13149,0>` (not used by VoP) |

```sh
cd api && node scripts/verify-module.mjs
# 1. sha256(committed versioned module) == 8641046e...
# 2. the module the testnet node serves for that reference is byte-identical to the committed file
# 3. both books <13172,0> and <13173,0> run that module reference     -> last line "VERIFIED: committed source build == module on chain == module both v3 books run"
```

Source == deployed, in CI on every push: `verify-v3-module` (archive == `src/`, hash == ref, node bytes == file, both books) and `verify-v3-build`
(`cargo concordium verify-build` rebuilds the committed archive in Concordium's pinned image). By hand:

```sh
cd contracts/payable_registry_v3
cargo concordium verify-build --module verifiable/payable_registry_v3.wasm.v1 --source verifiable/payable_registry_v3.wasm.v1.tar
```

Tests of the contract (101, incl. the property tests): `cargo concordium test` in `contracts/payable_registry_v3`; CI runs them and publishes the number (section 6).
What the chain enforces, and what it does not: it enforces the payee's signature, the cooling-off, the payee version and pay-once. **It does not verify the name proof.**

## 2. The verdict (Verification of Payee)

```sh
npx payonce-check-payee 4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin --name "Nour Design Studio"   # exit 0 match, 1 no match, 2 close match, 3 not possible
curl -s "https://payonce-api-n98a.onrender.com/api/vop/check?seller=3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr&payee=42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB&name=Totally%20Unrelated%20Corp"
# never MATCH for a name nothing stands behind; every answer carries an evidence_hash (sha256 of the facts used)
curl -s "https://payonce-api-n98a.onrender.com/api/vop/config"      # contract <13172,0>, module ref, cooling-off, the four verdicts, reject codes -28..-36
curl -s "https://payonce-api-n98a.onrender.com/api/vop/payee?seller=<seller>&payee=<payee>"   # the raw payee-book record the verdict was derived from
```

Read the verdicts honestly: **the testnet name proof is a labelled stand-in** (`standin: true`, "PayOnce Labs"): a name declared by the account owner, not a business identity issued by a
Global FinReg-style provider. A personal-identity account with no name proof is `UNVERIFIED` ("not possible"), never `MATCH`. `network=mainnet` is identity-only: never a match, never payable.
Re-run the benchmark and the red team yourself:

```sh
curl -s "https://payonce-api-n98a.onrender.com/api/proof/attacks?fresh=1"    # 30/30 attacks refused with the expected code, 18 distinct on-chain codes (-2 ... -36), node dry runs
curl -s "https://payonce-api-n98a.onrender.com/api/proof/false-green"        # 0 false MATCH, 0 false payable in 1,011 impostor checks (seed 20261128); cases: docs/proof/false-green-seed-20261128.json
```

## 3. Receipts: the verdict ledger and its anchors

Every verdict is a hash-chained receipt; the head is anchored on chain with registerData `PVOH1` (and after each signed approval).

```sh
curl -s "https://payonce-api-n98a.onrender.com/api/vop/ledger/verify"   # {"ok":true,...}: the chain recomputes and every anchor reads back finalized and equal
```

A wallet-signed approval of a close match (`/api/approvals/request` then `/verify`) is checked against the account's own keys on chain and written into the same ledger.

## 4. Identity: four agents with valid badges

The official check (note the path is `check-badge`; expect `"badge_valid":true`, `"issues":[]` and 15 checks each):

```sh
for t in JyP9XawpXHMjTN5ocrA5a JyP9Y9nGU4KaM7DBDXRgm JyP9Xp5bhbLsQrw7yTyph JyP9UE8M6sTcxSaorAr8W; do
  curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/$t?network=testnet" | grep -o '"badge_valid":[a-z]*'
done
```

| Agent | Token | Address |
|---|---|---|
| Seller 1 | 1476 | `JyP9XawpXHMjTN5ocrA5a` |
| Seller 2 | 1506 | `JyP9Y9nGU4KaM7DBDXRgm` |
| Buyer agent | 1488 | `JyP9Xp5bhbLsQrw7yTyph` |
| check_payee agent | 1554 | `JyP9UE8M6sTcxSaorAr8W` |

Cards: `https://payonce-tau.vercel.app/.well-known/registry/*.v4.json` (and `payonce-check-payee.v2.json`); evidence: [docs/evidence/registry-badge-check.json](docs/evidence/registry-badge-check.json), [docs/REGISTRY.md](docs/REGISTRY.md).
Packages: `npm view payonce-check-payee version`, `npm view payonce-mcp version` (0.1.2); MCP Registry: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=payonce"`.

## 5. x402: PayOnce sells a check, and verifies the buyer first

```sh
curl -si "https://payonce-api-n98a.onrender.com/api/x402/check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&name=Nour"      # 402, header PAYMENT-REQUIRED: 0.01 CCD, fee sponsored (open route)
curl -si "https://payonce-api-n98a.onrender.com/api/x402/agent-check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&name=Nour"  # 402 + buyerGate {mode: required, headers: X-Buyer-Agent, X-Buyer-Mandate}
curl -s  "https://payonce-api-n98a.onrender.com/api/x402/sales"      # every sale with its tx hash (and buyer_verified / buyer_mandate on gated ones)
```

**The two-way gate (Concordium workshop pattern: the merchant verifies the buyer).** On `/api/x402/agent-check-payee` the seller, *before settling*, requires that the paying account is a registry agent
(exists, Active, owner, MCP agent-of, `agentWallet == payer`, valid badge, all `ok`, none `not_run`) and presents a **signed spend mandate** that it re-verifies. The payer is known cryptographically from the signed payment.
A refused buyer gets `403 buyer_not_verified` and nothing is charged. The open route runs the same gate in `optional` mode (still sells, reports `verified:false`).

**The spend mandate** (reference buyer agent #1488, account `4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs`):

| What | Value |
|---|---|
| Mandate (sha256 of the signed text) | `c5b495352d03b1035d832e1ce2e9616ddd1a7e53fb1fd4c4ad965c473bd2bd7a` |
| Caps | 0.1 CCD per purchase, 1 CCD total, expires 2026-12-12 (12:44 UTC) |
| Signature | the buyer account's own key signs the text (`signMessage`) |
| Anchor | [`20532cf4…828a68`](https://ccdexplorer.io/testnet/transaction/20532cf4ef2ce8416f5c307510ac8893f9eadc1f9039a80d81653e98fa828a68): registerData `"PMD1"` + sha256(text), **sent by the buyer account** |
| Gated sale (verified buyer, mandate recorded) | [`4ab2fc1f…b36f`](https://ccdexplorer.io/testnet/transaction/4ab2fc1f393443ce7260654bbaba8431298f925fdc8f162603899f478492b36f), 0.01 CCD, sponsored fee |

```sh
cd api && node scripts/verify-mandate.mjs          # hash == sha256(text), text == stated caps, signature verifies against the account keys on chain,
                                                    # anchor finalized + sent by that account + carries PMD1+hash, every spend finalized and within the cap
curl -s "https://payonce-api-n98a.onrender.com/api/mandate/c5b495352d03b1035d832e1ce2e9616ddd1a7e53fb1fd4c4ad965c473bd2bd7a/spend"
```
CI runs the same script daily with a public node (`verify-mandate` workflow). The cap is enforced **by the buyer agent before it builds a payment** (and re-checked by the seller before it settles):
the 2 CCD purchase from Oracle Scout is refused with `over_per_purchase_cap` even when a person has approved it. This is a signed, anchored mandate, not a contract: nothing on chain *stops* a leaked buyer key from paying more;
the mandate bounds the agent's own behaviour and lets a merchant refuse a buyer that has no valid mandate.

A2A: `curl -s -X POST https://payonce-api-n98a.onrender.com/a2a -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1","parts":[{"kind":"data","data":{"payee":"4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin","name":"Nour"}}]}}}'`.

## 6. Tests: one number, from CI

```sh
curl -s https://raw.githubusercontent.com/mohamedwael201193/payonce/main/status/tests.json   # total / passing / failing / skipped, per suite, with the commit and the CI run URL
```

The number is parsed from the runners' own summaries (`node --test`, vitest, `cargo concordium test`) in the CI run it names and committed by CI; nobody types it. Skipped tests are listed as skipped, not as passing.

## 7. The standalone GitHub Action

[`mohamedwael201193/payonce-check-payee-action@v1`](https://github.com/mohamedwael201193/payonce-check-payee-action) fails a workflow unless the payee matches the name. Its own self-test runs on every push and daily, against the live API, and asserts the failing paths too.

## What is NOT verified here

- The name proof on testnet is a labelled stand-in; the chain does not verify the zero-knowledge proof, a keyless verifier does.
- The v3 contract is a verifiable build but has had no independent audit.
- Mainnet: identity-only, never a match. There is no mainnet payee book.
- Outside users: none has completed "become a payee" yet (see README).
