# PayOnce

An invoice becomes an on-chain **payable**: a payment instruction that can be
paid exactly once, only to the account the supplier put on chain.

- **Rail A (CCD):** the contract *is* the payment. `pay_ccd` forwards to the
  stored payee in the same transaction; a second payment reverts. Zero balance,
  always.
- **Rail B (EUDemo):** the agent's identity-born 2-of-3 account cannot move a
  cent until the registry reserves that exact payable for it; a deterministic
  co-signer co-signs only the exact transfer (stored payee, stored amount,
  memo = payable id).

Built for the **Concordium Trusted Agents hackathon (Encode Club)**.
**Testnet only. No mainnet, ever.**

> Every invoice becomes a payable that can be paid exactly once, only to the
> account the supplier put on chain. Pay in CCD and the contract *is* the
> payment.

## Verify it yourself

See [`VERIFY.md`](VERIFY.md) — every claim in this repo maps to a transaction
hash or a test run you can reproduce from the chain alone. No keys, no backend,
no trust in us.

## Layout

- `contracts/payable_registry/` — v1 registry (Rust, concordium-std 11).
  Live on testnet at `<13149,0>`.
- `contracts/payable_registry_v2/` — v2 (27 reject codes, H1/H2/race fixes).
  In progress — lands with the contract merge.
- `services/` — co-signer, keyless verifier, live scripts, scoped prover.
- `design/` — the "dawn teal / ink" design system (tokens, landing +
  dashboard mockups, generated assets). The static mockups are the design
  reference; the live app is `frontend/`.
- `frontend/` — the one-screen judge dashboard (React + Vite + TypeScript).
  Paste an invoice → 9 checks → pay → verified receipt → "try to break it".
  Judge console at `/judges`.
- `clicktest/` — the headless click-test (Playwright, 34 checks) that drives
  the real app in Chromium; log + screenshots in `clicktest/evidence/`.
- `qa/` — the verification suite (read-only chain reads, E2E runner, attack
  suite, secret scanner, Gate G0 checklist).
- `VERIFY.md` — the judge verification guide.
- `LICENSE` — Apache-2.0.

## Build and test

```sh
# Contract tests (v1: 26 tests; v2: 77 tests)
cd contracts/payable_registry && cargo test --release

# Co-signer decision table (35 cases)
node --test services/cosigner/test/

# Keyless verifier (no keys needed — reads the chain only)
node services/verify-payable.mjs <payable-id> <tx-hash>

# Frontend (69 unit tests; 18/18 contrast pairs; 34/34 headless click-test)
cd frontend && npm ci && npm run build && npm test && npm run check:contrast
node ../clicktest/clicktest.mjs   # drives the real app in Chromium
```

## Status

- v1 registry live at `<13149,0>`; both payment rails proven on testnet
  (see `VERIFY.md` for the hashes).
- v2 contract, co-signer v2, verifier v2, site and dashboard: in progress.
- Known limits are listed in `VERIFY.md` — including what is *not* yet live.

## Rules

- No mocks, no fake hashes, no stubbed flows.
- No secrets in this repo: no `.env`, no `*.private.json`, no seeds, no
  private keys.
- Testnet only. No mainnet transactions, ever.
- This repo contains only material that helps a judge verify the project.
