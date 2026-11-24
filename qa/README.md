# PayOnce QA — how to run the suite

Work dir: `~/workspace/payonce-build/qa/`. Testnet only. No sends, no
signing, no secrets. Every script is read-only except the E2E `--execute`
mode, which only runs on the ops host with keys.

## Setup
```sh
cd ~/workspace/payonce-build/qa
npm install   # @concordium/web-sdk + @grpc/grpc-js (package.json)
# The qa/ dir currently resolves the SDK via a symlink to the scratch
# node_modules; `npm install` replaces that with a real install.
```

## Commands
```sh
npm run verify:baseline   # node verify-chain.mjs — v1 contract + all 13 §5 txs + F10 evidence → out/baseline-verify.json
npm run attack            # node attack/attack-suite.mjs — A-F10 + A1..A20 → out/attack.json
npm run e2e               # node e2e/run-e2e.mjs — precondition check only (no sends)
npm run e2e:status        # print the E0–E12 table from out/e2e.json
node e2e/run-e2e.mjs --execute   # FULL live run (ops host only, needs v2 + backend + keys)
npm run scan              # node ci/secrets-scan.mjs ../.. — scans the whole work tree
node ci/secrets-scan.mjs ~/workspace/payonce   # scan the repo clone (current main)
node ci/secrets-scan.mjs . --history          # scan git history too (needs a repo)
```

## Config
`config.json` holds the pointers the suite resolves against. Until a field
is set, every dependent step reports NOT RUN — never green.
- `v2_contract`: {index, subindex} once the contract agent deploys v2.
- `backend_url`, `frontend_url`, `mcp_url`: once backend/frontend land.
- `v1_contract`: 13149 (module hash pinned). `seller_agent_token`: 1476.

## Rules (non-negotiable)
- A test you did not run is NOT RUN, never green.
- A PAIRED JUDGE re-runs the key tests and audits this checklist before
  anything merges. Write evidence so a stranger can re-verify it:
  full tx hashes, block hashes, reject codes, and the exact command run.
- CCDScan deep links: the explorer is an SPA; /tx, /transactions,
  /transaction, /contracts, /blocks routes all return 404 via curl from
  this VM. Evidence hashes are gRPC-verifiable (verify-chain.mjs);
  check explorer links in a browser before putting them in a report.

## Files
- `verify-chain.mjs` — read-only gRPC harness (instances + txs + F10).
- `e2e/run-e2e.mjs` — E0–E12 runner (plan P1 §6.4).
- `attack/attack-suite.mjs` — A-F10 + A1–A20 (plan P1 §6.1–6.4 negatives + VERDICT_V5 H1/H2/race).
- `ci/github-actions.yml` — CI definition (plan P1 §6.5: contracts, js, secrets; e2e is manual-only).
- `ci/secrets-scan.mjs` — secret/DOB scanner (64-hex tx hashes allowlisted).
- `gate-g0.md` — live Gate G0 checklist (the 9 pre-publish conditions).
- `QA_REPORT.md` — the full matrix with results.
- `out/` — machine-readable run outputs (baseline-verify.json, attack.json, e2e.json).
