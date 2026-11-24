# PayOnce API server

The P3 §16 HTTP layer over the merged PayOnce backend. Testnet only.

## Run

```bash
# 1. Install dependencies here AND in the backend (the server imports the
#    backend's modules; Node resolves their @concordium/web-sdk imports
#    from the backend's own node_modules).
npm install            # in this directory (api/)
npm install            # in the repo backend/ (or the work-tree backend/)

# 2. Start (default http://127.0.0.1:7401 — the port the frontend's
#    dev stub used, so the frontend + click-test work unchanged).
npm start
```

Environment (all optional unless a send is needed):

| Variable | Default | Notes |
| --- | --- | --- |
| `PAYONCE_API_PORT` / `PORT` | `7401` | Listen port |
| `PAYONCE_API_HOST` | `127.0.0.1` | Listen host |
| `PAYONCE_BACKEND_DIR` | auto-detected | Merged backend dir (repo `backend/` or work-tree `payonce-build/backend/`) |
| `PAYONCE_REGISTRY_INDEX` | `13150` | Registry instance index — set to the v2.1 instance when it lands |
| `PAYONCE_REGISTRY_MODULE` | v2 module ref | Registry module ref |
| `PAYONCE_ENV_PATH` | `…/concordium-trusted-agents/.env` | Wallet env (only needed for sends; read-only endpoints work without it) |
| `PAYONCE_DATA_DIR` | `api/data/` | Jobs, receipts, counters, documents, co-signer ledger |

No keys are ever printed, logged, or returned. Signers load lazily,
in-process only, on the first send.

## Test

```bash
npm run test:unit    # pure unit tests (no chain)
npm run test:live    # live read-only integration vs testnet (no sends)
npm run smoke        # FULL live E2E with real sends + real fees (creates
                     # fresh payables, pays CCD + EUDemo, runs the live
                     # chain attacks). Spends testnet CCD/EUDemo.
```

## Docs

`API_REPORT.md` — endpoints, how each maps to the backend modules,
tests, live evidence. `src/verify-payable-v2.mjs` — the keyless v2
verifier CLI for judges.
