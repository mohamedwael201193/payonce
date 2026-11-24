# Gate G0 — live checklist (plan Part A6, 9 conditions, ALL must be true before ANY publish)

Updated: 2026-11-24 ~09:37 EET by the integration lead (#1, #7, blockers item 2, wallet section — marked "(integration lead)"). Statuses are QA's own unless marked
"(integration lead)" or "(reported)". Evidence links are gRPC-verifiable
hashes; CCDScan deep-link URL format is UNVERIFIED from this VM (all
/tx|transactions|transaction|contracts|blocks routes return 404 via curl;
homepage returns 200 — it is an SPA, so links must be checked in a browser).

| # | Condition | Status | Evidence / blocker |
|---|---|---|---|
| 1 | H1, H2 and the race fix are LIVE on testnet, with negative-case tx hashes in the log | NOT MET | v2 contract NOT deployed. (integration lead) Deployer key AUTHORIZED for testnet use in-process (user 2026-11-24 09:31; ENV key, never printed; testnet only) — deploy unblocked, awaiting the contract agent's v2 delivery. H1/H2/race are design-only (plan §6.1). v1 live negatives verified by QA: -5, -6, -3, -16, -12, -17, -13 (see QA_REPORT §2). |
| 2 | F10 verifier binding fixed; F2 id-squatting fix live | NOT MET | F10 chain-half RUN: pay_ccd param id is readable on chain (tx 78377f18… param id 4; §5 pay_ccd param id 1). Verifier v2 fix NOT RUN (no verifier v2). F2 needs v2 contract (key = seller, id). |
| 3 | New seed, no use of the exposed seed anywhere | NOT MET | USER step. Leaked seed still the only key on file. QA never handles seeds. |
| 4 | Separate identity per role (owner, agent, seller company, second seller, ops) | NOT MET | USER step. All lab accounts come from one seed (plan R13). |
| 5 | No "Verified by Concordium" text unless check-badge returns badge_valid:true for that exact agent | PARTIAL | Frontend code bans the phrase unless badge.official === true (frontend/src/lib/copy.ts BANNED_WORDS). BUT the enforcing vitest (tests/copy.test.ts, cited in the code comment) does NOT exist — enforcement unverified. No live check-badge run by QA. |
| 6 | Wording audit passes ("reserved by the co-signer", not "held"; no "never pays a fake invoice" as an on-chain claim; "the chain refuses" only for real reverts) | PARTIAL | Frontend copy strings read by QA are honest (copy.ts: "Not verified…", "not yet (planned)", "Testnet only…"). Automated enforcement test missing (see #5). No deployed site to audit end-to-end. |
| 7 | No secrets in the repo, by scan; DOB literals redacted from public logs | MET | (integration lead) User deleted the repo himself 2026-11-24 09:14 EET; repo recreated PRIVATE 07:18:32Z, main ca90eac (1 commit, 17 files). Old commits 3fa8ca6/b681d5e NOT fetchable (git fetch origin <sha> → fatal: couldn't find remote ref, exit 128). Scans on the new main at the qa-suite merge: gitleaks v8.30.1 full-history CLEAN (1 commit, ~172,637 bytes, report []) AND QA scanner --history CLEAN (working tree + history, incl. qa/out/ scanned directly) AND targeted greps 0 (PEM headers, extended private keys, tokens, DOB literals, .env, *.private.json). Public flip still requires ALL 9 conditions + user go. Note: lab logs IDP_LOG.md / PROBE_LOG.md (NOT in this repo) still contain test DOB literals — redact before any public sharing of those logs. |
| 8 | Every number on the site comes from the live API; no sample numbers in the production build | NOT VERIFIED | Site NOT deployed. Frontend src grep: no hardcoded addresses/amounts. BUT the staging copy (~/workspace/payonce-site-staging/src/lib/recorded.ts:34) hardcodes testnet account B's address — must move to config, must NOT merge as-is. A dev-api-stub exists (frontend package.json `dev:stub`) — production build not inspected. |
| 9 | Independent-judge verdict on the frozen build recorded | NOT MET | No frozen build yet; no verdict. |

## Blockers summary (what must change before G0 can pass)
1. User deletes repo `mohamedwael201193/payonce` in the GitHub web UI (or provides a token with `delete_repo`), then it is recreated clean — old commits with DOB literals are fetchable by SHA until then (G0 #7).
2. (integration lead) Deployer key AUTHORIZED for testnet use in-process (user 2026-11-24 09:31) — v2 deploy is unblocked once the contract agent delivers v2. New seed still required before ANY publish (G0 #3, user step).
3. Separate identities + company identity + second seller (user, browser wallet) — G0 #4.
4. v2 contract deployed + verifier v2 + co-signer v2 live, then QA re-runs E0–E12 twice green on fresh payables (G0 #1/#2).
5. Frontend wording-enforcement test (tests/copy.test.ts) must exist and run in CI (G0 #5/#6).
6. Independent judge verdict on the frozen build (G0 #9) + user publish go (D1).

## Live wallet state (read-only, observed by QA 2026-11-24 ~09:14 EET; delta RESOLVED by the integration lead 09:24 EET)
- Wallet 42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB: **144,734.90 CCD**, nonce **161**, EUDemo **30** (allowList true). Balance stable since (QA judge re-read 09:35 EET: 144,734.898113 CCD, nonce 161).
- Delta vs merge-round end (145,423.21 CCD, nonce 151): **−688.31 CCD, +10 txs — RESOLVED: Claude's PayOnce v5 evidence run** (nonces 152–161, 06:48–06:52 EET): deploy payable_registry 409.51 + init `<13149,0>` 7.75 + Rail A/B matrix + 200 CCD transfer to account B `4MvdMEGC…`. Fees 487.31 + value 201.0 = 688.31 exactly (2 microCCD rounding). NOT the build workers. (QA did not send anything; all QA runs were read-only.)
