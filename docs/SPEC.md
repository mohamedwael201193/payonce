# VoP for agents: a short spec, and how it maps to the EU rules

**Status:** PayOnce's own convention, written down so another team can implement or test against it. It is not a standard and it is not legal advice.
**Version:** `payonce-vop/v1`, 28 Nov 2026. Reference implementation: `api/src/vop*.mjs`, `GET /api/check-payee`.

## 1. The idea in two lines
Banks must tell a payer, before the payer authorises a transfer, whether the name they typed matches the account they typed. An AI agent about to pay gets the same service: **before it pays an account, it asks "does this account belong to the name I was told to pay?" and acts on one of four answers.**

## 2. Four outcomes (same vocabulary as the EPC VoP scheme)
| Outcome (`verdict`) | EPC scheme result | What an agent does | Wire `epc_verdict` |
|---|---|---|---|
| `MATCH` | Match | Pays once, to this account only, if `payable` is true. | `match` |
| `CLOSE_MATCH` | Close Match (with the name of the counterparty) | Stops; a person decides. Shows `verified_name`. | `close_match` |
| `NO_MATCH` | No Match | Pays nothing. A person cannot override it from the agent. | `no_match` |
| `UNVERIFIED` | Verification check not possible | Stops; a person decides. It is **not** a match. | `not_possible` |
Rules that make it safe: the agent pays only on `payable: true` (a MATCH that is also bound by the payee's own signature, past its cooling-off, with the proof re-verified by a node); an unknown or missing verdict is treated as `UNVERIFIED`; nothing outside the four is ever read as a yes.

## 3. Interface
`GET /api/check-payee?payee=<account>&legal_name=<name on the invoice>[&seller=<account>][&country=XX][&network=mainnet]` (also `POST /api/vop/check`). Free, no key, rate limited (30/min/IP).
```json
{ "verdict": "MATCH|CLOSE_MATCH|NO_MATCH|UNVERIFIED", "epc_verdict": "match|close_match|no_match|not_possible",
  "payable": false, "verified_name": null, "verified_country": null,
  "identity_kind": "business|person|unknown", "standin": false,
  "mode": "identity_only",                       // present on mainnet only
  "reasons": ["..."], "checks": [{ "id": "account_identity", "ok": true, "detail": "..." }],
  "subject": { "network": "...", "payee": "...", "invoice_name": "..." },
  "evidence_hash": "<64 hex>", "checked_at": "<ISO UTC>" }
```
- **Networks.** `testnet` (default): the full check (payee book `<13172,0>`, ZK name proof, cooling-off). `mainnet`: **read-only, identity-only**: it reads the account's identity provider from a node, never returns `MATCH`, never `payable: true`, and says so in `mode` and `reasons`. There is no mainnet payee book yet.
- **Latency.** Typically 0.2 to 0.4 s warm (the EPC scheme allows 5 s).
- **Errors.** 400 `bad_address` / `bad_name`; 429 `rate_limited`; 503 `mainnet_unreachable` (no verdict is ever invented when the node cannot be read).
- **`evidence_hash`** = sha256 of the canonical JSON (keys sorted, no spaces) of `{verdict, verified_name, verified_country, identity_kind, standin, checks, subject}`. Same input state, same hash.
- **x402.** `POST /api/x402/probe {url, name}` reads a seller's 402 without paying and runs the check on its `payTo`. A mainnet `payTo` gets the identity-only check automatically.
- **Receipts.** `POST /api/vop/anchor {payee, name}` anchors `"PVOP1" + evidence_hash` on Concordium testnet with `registerData`; `GET /api/vop/anchor/<evidence_hash>` shows the transaction, the stored evidence, whether the hash recomputes and whether the chain bytes match.

## 4. Conformance tests (any implementation can run these)
1. An account that does not exist on the network -> `NO_MATCH`, `payable:false`.
2. An account with only a personal identity and no name proof -> `UNVERIFIED`.
3. A business identity with no name proof -> `UNVERIFIED`, `identity_kind: business`.
4. A proven name equal to the invoice name (case, punctuation, company-suffix insensitive) -> `MATCH`.
5. A proven name that differs by a word ("Acme GmbH" vs "Acme Holding GmbH") -> `CLOSE_MATCH`, `verified_name` shown.
6. A proven name that is a different party -> `NO_MATCH`.
7. `MATCH` without the payee's own signed binding or inside its cooling-off -> `payable:false`.
8. Mainnet mode never returns `MATCH` and never `payable:true`.
9. A node outage returns an error, never a verdict.
10. The same state returns the same `evidence_hash`; changing any `checks` entry changes it.
11. A caller cannot make the service anchor a hash it did not compute.
12. An unknown verdict string is handled as "not possible".
In this repo: `api/test/vop.test.mjs`, `vop-mainnet-census.test.mjs`, `vop-anchor.test.mjs`; live: `node tools/census/check-live.mjs`.

## 5. Mapping to the EU rules
| EU requirement | Source | PayOnce for agents |
|---|---|---|
| The payer's PSP must offer a service that verifies the payee **before the payer can authorise** the credit transfer, on any initiation channel. | Reg. (EU) 2024/886 (amends the SEPA Regulation 260/2012), new Art. 5c(1) | The agent calls `check_payee` before it signs, as a precondition in its policy; the contract refuses a `pay` that skips the checks (reject codes -28 to -36 on testnet). |
| Name typed by the payer is matched against the account identifier; on a **mismatch** the payer is told that authorising may send funds to an account not held by the intended payee. | Art. 5c(1)(a) | `NO_MATCH`: the agent refuses and tells the person why (`reasons`). |
| On an **almost match**, the payer is shown the name associated with the account. | Art. 5c(1)(a) | `CLOSE_MATCH`: the agent stops and shows `verified_name`. |
| Where the payee is a legal person, other unambiguous data (fiscal number, EUID, LEI) may be matched instead of the name. | Art. 5c(1)(b) | **Not implemented.** The business proof reveals `legalName` and `legalCountry` only. Adding an identifier is a listed next step. |
| Euro-area PSPs from **9 Oct 2025**, non-euro Member States from **9 Jul 2027**; offered **free of charge** to the payer. | ECB summary of the IPR | `check_payee` is free, no key. |
| Four results: Match, Close Match (with name), No Match, Verification check not possible; response within a maximum time (5 s). | EPC VoP Scheme Rulebook (EPC218-23) | The four verdicts above; typically under 0.5 s warm. |
| **PSR (provisional agreement 27 Nov 2025, formal adoption pending at the time of writing):** the name/identifier check extends to all credit transfers; a PSP that fails to warn of a detected mismatch becomes liable for the loss; impersonation fraud is refunded by the PSP under conditions. | Council / Parliament press releases of 27 Nov 2025; article numbers (Art. 50, Art. 60) are from the provisional text and may change | PayOnce does not claim to satisfy these: they bind PSPs. They are the reason the check belongs in an agent's path: the party that skips it carries the loss. |

## 6. What this does not claim
- PayOnce is **not a payment service provider** and does not perform Art. 5c. The mapping is by analogy: the same four outcomes, applied by an agent to a crypto account.
- A Concordium identity is not a bank-held account name. A business identity proves *a company* stands behind the account; the *name* needs a zero-knowledge name proof or a payee-signed binding.
- Testnet names are self-asserted mock identities; the chain does not verify the ZK proof, a keyless verifier does (anyone can re-run it).
- Mainnet mode is identity-only. We have measured it: of 5,501 registered mainnet agents at most 5 meet the preconditions today (census, `tools/census/METHOD.md`).

## Sources
- Regulation (EU) 2024/886, Art. 5c: https://eur-lex.europa.eu/eli/reg/2024/886/oj/eng
- ECB, Instant Payments Regulation (deadlines, free of charge): https://www.ecb.europa.eu/paym/retail/instant_payments/html/instant_payments_regulation.en.html
- EPC Verification Of Payee Scheme Rulebook (EPC218-23): https://www.europeanpaymentscouncil.eu/ (document register)
- Council press release, PSR/PSD3 provisional agreement, 27 Nov 2025: https://www.consilium.europa.eu/en/press/press-releases/2025/11/27/payment-services-council-and-parliament-agree-to-step-up-the-fight-against-fraud-and-increase-transparency/
- European Parliament press release, 27 Nov 2025: https://www.europarl.europa.eu/news/en/press-room/20251121IPR31540/payment-services-deal-more-protection-from-online-fraud-and-hidden-fees
