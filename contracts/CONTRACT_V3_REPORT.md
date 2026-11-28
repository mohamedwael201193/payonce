# payable_registry_v3 — Verification of Payee (VoP) for AI agents

Testnet only. Source: `payable_registry_v3/src/lib.rs`. Tests: `payable_registry_v3/tests/payable_v3.rs` (101 tests, `cargo concordium test`, log in `payable_registry_v3/test-log.txt`).

## Why
Since 9 Oct 2025, Regulation (EU) 2024/886 (Instant Payments Regulation) requires euro-area payment providers to offer Verification of Payee: the payee's name is checked against the account before the transfer, with the answers Match / Close match / No match. An AI agent paying an invoice has nothing like it, so an "our bank details changed" e-mail or a prompt injection can redirect money. v3 is the on-chain half of a VoP check for agents; `check_payee` (API) is the keyless off-chain half.

## What the chain enforces (v2.1 + payee book)
| Step | Entrypoint | Sender | Enforced |
|---|---|---|---|
| 1 | `propose_payee {payee, agent_token, identity}` | seller | seller's CIS-8004 agent exists, Active, owned by seller (`agentOf` cross-call); identity anchor well formed |
| 2 | `accept_payee {seller, version, proof_anchor}` | **the payee account itself** | proposal exists; payee repeats the exact version and proof anchor (its signature covers the identity anchor) |
| 3 | cooling-off | — | `mature_at = bound_at + cooling_off_secs` (init param, 60 s … 30 days; demo 600 s) |
| 4 | `acknowledge_payee {seller, payee, version, verdict, evidence_hash}` | buyer | payee Bound, version current, verdict ∈ {Match, Close match}, evidence hash non-zero, buyer ≠ seller/payee |
| 5 | `register_payable` | seller | payee Bound in this seller's book; stores `payee_version` |
| 6 | `pay_ccd` / `reserve_plt` | buyer | all v2.1 checks, then payee Bound, same version as at registration, cooling-off over, this buyer acknowledged this version |
| — | `propose_payee` again (details changed) | seller | version+1, back to Proposed, cooling-off restarts, old acks and old payables void |
| — | `revoke_payee` | seller or payee | immediate, version+1 |

`PayeeIdentity` = `{kind (1 business, 2 person), idp_index, legal_name_hash, country, proof_anchor, anchor_tx}`. Global FinReg is IdP 4 on testnet and 3 on mainnet; the contract stores the index, never assumes it.

**Honest boundary.** A contract cannot verify a ZK presentation. The chain enforces who signed (seller + payee), when (cooling-off), who accepted the risk (buyer acknowledgment, with the VoP verdict and evidence hash recorded) and what was anchored (hashes). That the anchored presentation is valid, belongs to the payee account's credential and reveals the claimed legal name is checked by `check_payee`, which anyone can re-run without keys.

## Reject codes
-1..-27 are unchanged from v2.1 (frozen). v3 appends:

| Code | Name | When |
|---|---|---|
| -28 | PayeeNotBound | payee not accepted by its own account, or revoked |
| -29 | PayeeNotMature | cooling-off still running |
| -30 | PayeeNotAcknowledged | this buyer has not acknowledged this payee version |
| -31 | PayeeChanged | payee details changed after the payable was registered |
| -32 | PayeeNotProposed | accept without a pending proposal for (seller, sender) |
| -33 | AnchorMismatch | payee accepted a different proof anchor |
| -34 | PayeeVersionMismatch | caller named a stale version |
| -35 | NotPayeeParty | revoke by someone other than seller or payee |
| -36 | VerdictNotPayable | acknowledgment with verdict No match / Unverified |

## Kept from v2.1
Pay exactly once (-5/-16), exact amount (-6), CIS-8004 `agentOf` (-8/-9/-10/-11), vendor list / strict (-19), caps (-23), expected payer (-21), PLT reservation window, `pay_ccd` forwards in the same transaction (the contract holds no balance across transactions).

## Tests (101/101)
- The full v2.1 matrix (83, incl. property tests I-01..I-07) runs unchanged on a bound, matured, acknowledged payee. m02 adapted: -15 via a missing payee account is now unreachable (a missing account cannot accept).
- VOP-01..VOP-18: propose/accept/revoke/acknowledge matrices, cooling-off to the millisecond, per-buyer acknowledgment, the "bank details changed" flow (old invoice frozen, -28 then -31), PLT rail, init bounds, the stolen-seller-key BEC scenario (no CCD moves), no-event/no-view-change on rejects, pay-once on a verified payee.

## Verifiable build
`cargo concordium build --verifiable --verifiable-image docker.io/concordium/verifiable-sc-wasm32v1:1 --source-link <raw tar URL> --out verifiable/payable_registry_v3.wasm.v1` (cargo-concordium 5.0.0). `cargo concordium verify-build --module verifiable/payable_registry_v3.wasm.v1` → "Source and module match." Deploy record: `scripts/deploy-v3-result.json` (after deploy).
