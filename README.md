# PayOnce

**Every invoice becomes an on-chain payable that can be paid exactly once, only to the account the supplier put on chain.** In CCD the registry contract forwards the payment in the same transaction; a second payment reverts. Concordium testnet only.

- Site: https://payonce-tau.vercel.app (owner proof, badges and trust model on [/app/judges](https://payonce-tau.vercel.app/app/judges))
- API: https://payonce-api-n98a.onrender.com (`/api/health`, `/api/stats`, `/api/invoices`)
- Registry contract: [`<13150,0>`](https://ccdexplorer.io/testnet/instance/13150/0) (v2). Agents are registered on the official CIS-8004 registry [`<12802,0>`](https://ccdexplorer.io/testnet/instance/12802/0).
- x402 settle receipt: https://payonce-tau.vercel.app/app/x402

Built for the Concordium Trusted Agents hackathon (Encode Club). **Testnet only. No mainnet, ever.**

## Verify it in three commands

No keys, no `.env`, read-only.

```sh
# 1. A real payment, re-read from the chain (expected: ALL CHECKS PASS (10/10))
cd backend && npm ci && cd ../api && npm ci
node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt

# 2. The seller agent's badge, asked of the official registry (expected: "badge_valid":true, status Active)
curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a?network=testnet"

# 3. The accountable human behind the sellers: owner proof, 18+ and EU (expected: ALL CHECKS PASS (8/8))
cd ../backend && node scripts/verify-owner-proof.mjs https://payonce-tau.vercel.app/proofs/owner-proof.json
```

More in [`VERIFY.md`](VERIFY.md): every claim maps to a transaction hash or a command you can run.

## What it does

- **Rail A (CCD):** the contract is the payment. `pay_ccd` forwards to the stored payee in the same transaction. A second payment, a wrong amount or an unknown id reverts with a code. The registry holds zero balance.
- **Rail B (EUDemo):** the payer reserves the exact payable on chain, a co-signer gate decides, the EUDemo transfer carries the canonical memo `payable:<seller>:<id>`, and the payer confirms. The contract cannot see token transfers, so the verifier is the check to trust. On this rail a wrong payee is refused by the co-signer and flagged by the verifier. It is not a contract revert.
- **Agents:** two seller agents (tokens 1476 and 1506) and the payer agent (token 1488) are registered on the official registry. The seller token is cross-checked by the contract at registration and at payment.
- **Strict vendor list (default on):** an unlisted seller is refused on both rails. On EUDemo the chain refuses too (-19). On CCD the API refuses before it signs, because the contract's own strict flag (`set_strict`, a buyer action on the registry) is still off. See "Trust model" below.

## Trust model, honestly

- One operator runs everything: the API on Render and the site on Vercel. There is no outside buyer yet.
- One testnet seed, loaded in-process on the API host, derives the owner, seller 2, the demo payer and the sponsor. It is not in this repo (the CI secret scan checks the tree and the history).
- The co-signer is a decision gate inside the API process. It decides and the same process signs, so on the EUDemo rail it is a policy we run, not a second party. A separate co-signer service exists in `backend/src/cosigner` but is not what the site runs.
- The accountable human is a testnet identity. The owner of seller 1 has a published Verify and Access V1 proof (18+ and EU), anchored on chain, from the testnet identity provider with test attribute values. There is no LEI and no company proof.
- Seller 2's owner has no proof of its own: an attempt was refused by the verifier-side check.

## Layout

- `contracts/payable_registry_v2/` is the deployed registry (`<13150,0>`, Rust, concordium-std). `payable_registry_v2_1/` (`<13152,0>`, adds `record_payment_tx` and the -18 fix) is deployed and verified but is **not** the deploy target: the API still serves v2. `payable_registry/` is v1 (`<13149,0>`, superseded). Reports: `contracts/CONTRACT_REPORT.md`, `contracts/CONTRACT_V21_REPORT.md`.
- `api/` is the HTTP API and pay jobs (both rails, the vendor-list gate, the keyless verifier `api/src/verify-payable-v2.mjs`).
- `backend/` holds the verifier modules, the co-signer decision table, the x402 facilitator code and recorded evidence (`backend/test/`), and `backend/scripts/verify-owner-proof.mjs`.
- `frontend/` is the site and app (React, Vite, TypeScript). Public proofs live in `frontend/public/proofs/` and `frontend/public/evidence/`; agent cards in `frontend/public/.well-known/`.
- `qa/` has the live end-to-end run, the attack suite and the secret scanner. `clicktest/` is the headless click test.
- `services/` is the original v1 co-signer and prover (kept for the record).

## Build and test

```sh
cd frontend && npm ci && npm test && npm run build
cd api && npm ci && node --test test/*.test.mjs    # offline, stubbed chain (live.test.mjs reads the testnet)
cd backend && npm ci && node --test test/*.test.mjs
node --test contracts/cosigner/test/decide.test.mjs
cd contracts/payable_registry_v2_1 && cargo concordium test
```

CI (`.github/workflows/ci.yml`) runs the secret scan, the API, backend and frontend tests and the frontend build on every push.

## Known limits

- Only the CCD rail moves value inside the contract's own transaction. The euro rail is co-signer-bound: the guard precedes the payment, enforced by a key holder.
- A buyer who approves a fraudster can still be defrauded. The guarantee is that each payable is paid at most once, exactly, to the payee its issuer stored.
- The hosted x402 facilitator answered "not found" to `/settle` while the chain had confirmed the transfer. The receipt page shows both.
- The live registry holds many payables created by our own automated test runs. The site leads with demo invoices and counts the test runs apart.
- Testnet fees and the EUDemo token are not real money.

More limits, with the reasoning, are on [/app/judges](https://payonce-tau.vercel.app/app/judges) and in `VERIFY.md` section 6.

## Rules

No mocks passed off as real, no fake hashes, no secrets in this repo (no `.env`, no `*.private.json`, no seeds), testnet only. License: Apache-2.0.
