# PayOnce

An invoice becomes an on-chain **payable**: a payment instruction that can be
paid exactly once, only to the account the supplier put on chain.

- **Rail A (CCD):** the contract *is* the payment. `pay_ccd` forwards to the
  stored payee in the same transaction; a second payment reverts. Zero balance,
  always.
- **Rail B (EUDemo):** the agent's identity-born 2-of-3 account cannot move a
  cent until the registry reserves that exact payable for it; a deterministic
  co-signer co-signs only the exact transfer (stored payee, stored amount,
  memo = the canonical payable memo — v1 `payable:<id>`, v2
  `payable:<seller>:<id>`).

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
  Live on testnet at `<13150,0>` (module `c8083a94…`, 80/80 Rust tests,
  35/35 co-signer cases, 25/25 live matrix — see `contracts/CONTRACT_REPORT.md`).
- `contracts/payable_registry_v2_1/` — v2.1 (the −18 fix + `record_payment_tx`).
  Live on testnet at `<13152,0>` (module `a299ab6b…`, 83/83 Rust tests,
  35/35 co-signer cases, 33/33 live matrix — see
  `contracts/CONTRACT_V21_REPORT.md`). **Not the deploy target yet** — the
  deploy target stays v2 `<13150,0>` until the API server's v2.1-switch fix
  lands and is re-verified on v2.1 (see `VERIFY.md` §6).
- `services/` — v1 co-signer, live scripts, scoped prover. (The v1 keyless
  verifier there is superseded — it does not run from a fresh clone; the
  working verifier is `backend/src/verifier/`.)
- `backend/` — the live backend: keyless verifier (F10 binding fix, 12 CCD /
  15 PLT checks), deterministic co-signer (decision gate + server),
  x402 facilitator (Doris's 9 checks + 4 safeguards), x402 flows, MCP tool
  server, Art. 12 receipt verifier, EasyPost test capture, D5 invoice
  adapter (OFF by default). 175/175 tests — see `backend/BACKEND_REPORT.md`.
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
# Contract tests (v1: 26 tests; v2: 80 tests incl. the full 27-code reject matrix; v2.1: 83 tests)
cd contracts/payable_registry && cargo test --release
cd contracts/payable_registry_v2 && cargo concordium test   # 80 tests (Chain engine)
cd contracts/payable_registry_v2_1 && cargo concordium build && cargo concordium test   # 83 tests (Chain engine; build first — it regenerates concordium-out/module.wasm.v1)

# Co-signer decision table (35 cases)
node --test contracts/cosigner/test/decide.test.mjs

# Backend (175 tests: verifier, co-signer, facilitator, x402, MCP, receipts)
cd backend && npm ci && node --test test/*.test.mjs

# Keyless verifier (no keys needed — reads the chain only)
cd backend && node src/verifier/verify-payable.mjs <payable-id> <tx-hash> --rail ccd

# Frontend (155 unit tests; 18/18 contrast pairs; 34/34 headless click-test)
cd frontend && npm ci && npm run build && npm test && npm run check:contrast
node ../clicktest/clicktest.mjs   # drives the real app in Chromium

# API server (47 unit tests: consent, MCP client, balance watch, buyer agent, CIS-8, Art. 12 receipts, G7 fix-back-3–9 verifier checks)
cd api && npm ci && node --test test/unit.test.mjs
```

## Status

- v1 registry live at `<13149,0>`; both payment rails proven on testnet
  (see `VERIFY.md` for the hashes).
- v2 contract live at `<13150,0>` (80/80 + 35/35 + 25/25 live matrix); the
  live success path is proven on chain — the 8-tx happy path ran
  2026-11-24 ~08:36–08:38 UTC (roles mirrored: seller = owner, payer = B;
  see `backend/BACKEND_REPORT.md` §6). Gate G0 #1 is MET.
- v2.1 contract live at `<13152,0>` (83/83 + 35/35 + 33/33 live matrix;
  happy path all passed). The −18 fix and `record_payment_tx` both work
  live; the view's `txHash` now pins the CCD payment tx
  (`d0f30224…`). **Not the deploy target yet** — the deploy target stays
  v2 `<13150,0>` until the API server's v2.1-switch fix lands (see
  `VERIFY.md` §6).
- Verifier v2 + live backend: merged (175/175 tests; F10 proven live by an
  independent re-run; MCP live pay Rail A 12/12 + Rail B 15/15).
- Known limits are listed in `VERIFY.md` — including what is *not* yet live.

## Age proof (V&A, G8) — testnet

- The `/verify-age` page proves 18+ (and EU nationality) with a
  zero-knowledge presentation from the holder's Concordium credential,
  checked by the official testnet verifier — without revealing the birthday.
  Payments of 1 CCD or 1.00 EUDemo and up need a fresh verified 18+ proof
  for the payer (see `api/src/age-proof.mjs`).
- Filing is IN MEMORY (Batch C fix-back — the spec's `age_proof` body field
  does not exist): a proof gets on file only inside `POST
  /api/age-proof/verify`, after the official verifier returns 200 for a
  presentation the prover built. No client claim is ever trusted. Filed
  proofs live in process memory with a ≤10-minute freshness window; a
  server restart loses them and the payer simply re-verifies (the verify
  call is free). No store persistence.
- Statements are derived from the request actually proven (a
  nationality-only proof claims no age and files nothing); the filed record
  is bound to the presentation's credential holder, resolved on chain via
  `getAccountInfo(credId)`, and must equal the payer.
- `POST /api/age-proof/verify-presentation` verifies a client-supplied
  presentation straight against the official verifier — verification only,
  nothing filed. That is the live-400 leg: a tampered presentation returns
  the real HTTP 400 through the API without the prover sidecar.
- BLOCKED (not hidden): the prover sidecar file (`prover-C3.private.json`)
  is not in this workspace, so the live 403 rules and the full live loop
  (verify → file → pay succeeds) cannot run until it is provisioned on the
  API host; the planner's live run (G7) is logged at
  backend/test/llm-planner-live-2026-11-24.json (10/10 reliability, 0 pay_payable dispatches). Until the sidecar is provisioned the age
  routes fail closed with 503 `prover_unavailable` and age-gated pays stay
  409.
- Precision: no under-18-holder test has ever been run — the proven live
  rejections are forbidden shapes (prover 403) and a tampered presentation
  (verifier 400). No copy here claims otherwise.

## Path to production

PayOnce runs on Concordium testnet today. The path to the live network is:

1. **A new seed before any publish.** One testnet seed holds the keys in this
   demo (in-process, testnet only) and it must never reach a publish.
2. **Sponsored onboarding.** Merchants and agents onboard to the live network
   without buying CCD first — registration is sponsored.
3. **Euro rail: PLL migration.** Simple locks land January 2027 (recipients,
   PLT-only, expiry, grants that fund/send/release/cancel, keep-alive);
   Enhanced locks land March 2027 (smart-contract-driven). Our mapping today:
   recipients = the merchant allow-list; tokens = EUDemo; expiry = the order
   window; send grant = the agent; fund grant = the owner; release and cancel
   = the owner. Until the locks land, the mandate contract is the on-chain
   version of the same controls.
4. **Custody stays non-custodial.** The owner recovery key stays in the user's
   own wallet, never on the server; the agent acts through a headless
   credential of the human identity and holds only the ZK proof. Named
   alternatives, none integrated: Agent IDP (the agent holds only revealed
   attributes — testnet status unverified, no migration claimed), DFNS
   wallet-as-a-service (MPC, API signing), Tether WDK branded wallet (human
   consent on the roadmap).
5. **The co-signer moves out.** It runs inside this API server today; in
   production it is a separate service on a separate host.
6. **Company identity is a user-side step.** LEI / Global FinReg approval is
   not built here and not claimed.
7. **Second store: Varox evaluated.** Varox (the programme's V&A partner) was
   evaluated for the second store's verification: no public evidence of its
   API or demo exists, so we build V&A V1 ourselves and keep Varox as the
   named partner option for the second store, contacted via the programme.
8. **Fees at the peg.** Concordium's fee peg is €0.01 per transaction: a CCD
   payment is 3 transactions (€0.03), an EUDemo payment 5 (€0.05), an
   above-threshold EUDemo payment 7 (€0.07, consent VRA + VAA included). See
   the fee table on the judge page.

## Rules

- No mocks, no fake hashes, no stubbed flows.
- No secrets in this repo: no `.env`, no `*.private.json`, no seeds, no
  private keys.
- Testnet only. No mainnet transactions, ever.
- This repo contains only material that helps a judge verify the project.

## UI/UX fix-back (code complete 2026-11-25 ~00:30 EET — screenshots pending)

Patch set on top of Batch C (main `6ac73e3`): every gap in the independent
UI/UX verdict on `14d47ee` (7.5/10) is fixed in code — N1 one refused number
with an always-visible basis caption, N2 `status_paid` detail + single
`Verdict:` prefix, N4 bottom-pinned rails, vivid-orange sky regrade
(`hero-sky.webp` 169 KB → 43 KB, top pixel (122,35,1) → (196,82,15)),
ember orbs removed, logo once-loop thickened for 32 px, stats reconciled at
the API source (`api/src/listable.mjs`: listable rows only; voided/reserved
reported, not hidden), loading skeletons (no more `0` cards), honest copy
(`Verify — no wallet needed`; co-signer sentence), Features flat hairline
grid with corner squares, hero demo reshaped into a small static glimpse
(fix-back-6 B6: chips + 3-row live table + link; no autoplay, no steps, no
checks, no pay button, no receipt, no cursor — the walkthrough is gone).
N3 ruling: LiveStatsBand 2×2 @768 is BY-DESIGN (`lg:grid-cols-4`,
Batch D compliance judge entry 0400 + coordinator note) — grid unchanged.
Verified by my own runs (fix-back-12, 2026-11-25 ~13:26 UTC): frontend
vitest 257/257 (24 files), TWICE in a row (run 1: 98.54 s, run 2: 105.18 s),
`tsc -b` clean (this repo has no `tsconfig.app.json`; the build script's
`tsc -b` is the check), `vite build` clean twice (547.06 kB JS, 547,060 B,
`assets/index-BcWdgTs-.js`, sha256
`0916be6ee81f42c9378a336a8a069ed5a8eb5d7265721afe6198a1ca0341a525`, identical
across both builds; CSS 50.20 kB, 50,196 B, sha256 `47236f54…f558` — NOT
byte-identical to fix-back-9: 15 B smaller from Tailwind v4 tree-shaking
after the home pay flow was removed, see `qa/fixback12.md` §9), API
stats-reconcile test 3/3, handler-level stats/invoices test 5/5,
handler-level payableFacts test 7/7 (from a `/var/tmp` copy with read-only
symlinked node_modules; `api/node_modules` in-tree is still absent — see
`qa/fixback11.md`), secret scan clean on the diff (0 genuine hits).
Fix-back-11 fixes the fix-back-10 panel list (0/3 — all three judges
converged on one defect): verification now has a whole-round budget of
20 s per poll tick on top of the 5 s per-page deadline, so a slow host
failing late can no longer re-pay full slow pages on every attempt —
one poll tick's verification + backoff tops out at 23 s (a hung first
page is 18 s of verification), inside the 30 s poll ONLY when the pair
fetches are fast — the pair fetches sit outside the budget (each capped
only by the 15 s fetch timeout), so the whole-tick worst case is 68 s
(3 × 15 s pair + 20 s verify + 3 s backoff); while the legit 11-drop
heal at 3 s/page still lands on attempt 1 in ~6 s, a heal needing more
than 20 s of verification fails closed that tick and stays stale under
a sustained slow host; the three unqualified "18 s" claims are corrected
to that qualified bound
(hung-first-page 18 s vs slow-host 5 s × pages per attempt, capped by
the 20 s tick budget). See `qa/fixback11.md`.
Fix-back-10 fixes the fix-back-9 panel list: the feasibility rule is now
the TIGHT one (Δreserved+Δvoided ≥ shrink, both regimes — the fix-back-9
rule treated a confirm as list-neutral and double-counted voided growth,
and the old no-fall rule assumed zero creates); verification has a 5 s
deadline PER PAGE, so a legit 11-drop shrink heals on a 3 s/page host;
the caller abort really reaches the fetch on runtimes without
`AbortSignal.any` (manual forwarding controller); `useLiveSnapshot` has
`retry: 0` (fetchLiveSnapshot already retries in-loop). Fix-back-10
stated one poll tick as topping out at 18 s — that holds only for a
hung first page; fix-back-11 corrects it to the qualified bound
(verification ≤ 20 s + 3 s backoff = 23 s of verification + backoff only;
whole-tick worst case 68 s with the pair fetches, "inside the 30 s poll"
only when they are fast).
See `qa/fixback10.md` and `qa/fixback11.md`.
Fix-back-9 fixes the fix-back-8 panel list: reserved is NOT terminal on
chain, so monotonicity is voided/paid-only and a reserved fall is accepted
when explained (release / confirm / void-of-reserved, feasibility
Δreserved+Δpaid+2·Δvoided ≥ shrink); per-id verification now runs whenever
ANY id dropped, not only on a net shrink (same-count swap and net-growth
drop both rejected); verification pages in 10s so a legit >10 shrink heals
instead of freezing (within the 20 s whole-round tick budget added in
fix-back-11); verification has a 5 s deadline so a slow per-id
endpoint fails the attempt fast; `payableFacts`/`handleGetPayable` are
exported with the read through the S5 seam and the Voided mapping has an
offline test (see `qa/fixback9.md`).
Fix-back-8 fixes the fix-back-7 panel list: the snapshot shrink rule is
now two layers — per-counter monotonicity plus per-id verification of
every dropped id via GET /api/payables/:id (Voided is its own facts kind
now, `{kind:'voided'}`) — closing the adversarial id-50 hole where a
partial scan coincided with a net add; the flaky MF-6 test waits for the
settled CountUp values; the receipt single-fail note names only the
missing record; the hero shows the same could-not-refresh note as the
dashboard plus a "Last updated" line; plus the S1–S3 small items (see
`qa/fixback8.md`).
NOT yet verified: live screenshots — the VM lost every working browser in
the 01:45 EET reboot (Chromium 1255 dead, stock Firefox lacks Playwright's
Juggler protocol, Playwright's Firefox CDN returns 400 via the egress
proxy, intermittent EPERM write-block on downloads). The verification
script is ready (`../batch-uiux-fixback/verify.mjs` + `api-shim.mjs`,
preview :4174, shim :17411); run it from a browser-capable session before
claiming the visual fixes. Live numbers move while other agents test —
verify against live stats, never a hardcoded total. (Refused is an event
count since deploy, not a payable count, so it never sums with
payables/paid.)
