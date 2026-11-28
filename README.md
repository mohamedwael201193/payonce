# PayOnce

[![CI](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml) [![status monitor](https://github.com/mohamedwael201193/payonce/actions/workflows/monitor.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/monitor.yml) [![census](https://github.com/mohamedwael201193/payonce/actions/workflows/census.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/census.yml)

**An AI agent checks who it is paying (Match / No match) before any money moves, and pays each invoice exactly once.**
Concordium testnet only. No mainnet, no real money. Built for the Encode Club × Concordium Trusted Agents Hackathon.

**Live:** [app](https://payonce-tau.vercel.app/app) · [proof](https://payonce-tau.vercel.app/app/proof) · [API](https://payonce-api-n98a.onrender.com/api/config) · [CI](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml)

## The 30-second story

1. An invoice is registered once on a Concordium smart contract: payee, amount, due date, the SHA-256 of the invoice text, and the seller's agent token on the official CIS-8004 registry.
2. Before paying, the agent asks the chain, not the email: does the payee on chain match the invoice, is the seller a valid registered agent, is it already paid? **Match:** it pays. **No match:** nothing moves.
3. On CCD the contract is the payment: it forwards the money to the stored payee in the same transaction, so a second payment, a wrong amount or an unlisted seller reverts with a code.
4. Anyone can re-read any payment from the chain with a script that needs no keys and no account.

Open [/app](https://payonce-tau.vercel.app/app) and run it on a real testnet invoice: payer, invoice, check, approve, paid once, receipt.

## What is real today, and what is not

| Part | Status |
| --- | --- |
| Payable registry v2, instance [`<13150,0>`](https://ccdexplorer.io/testnet/instance/13150/0) | Deployed, used by the app. Not a verified build on CCDExplorer |
| Registry v3 (payee book, cooling-off, buyer acknowledgment), instance [`<13172,0>`](https://ccdexplorer.io/testnet/instance/13172/0) | Deployed, with a check API (`/api/vop/config`). The app does not use it yet; its first payee bindings are still to be run |
| EUDemo rail | The guard runs in our API before the transfer. The contract cannot see tokens, so the verifier is the check to trust |
| 18+ identity check | Real Concordium proof (V&A V1, anchored request and result), built by a hosted prover that holds one testnet credential. Not a person's own wallet |
| Owner approval above 1 CCD | Lab only: built headlessly from a seed. No human wallet is involved yet |
| Users | None outside us. One testnet seed derives the owner, seller 2, payer and sponsor |

More, with reasons: [docs/DETAILS.md](docs/DETAILS.md) (Honest limits) and [VERIFY.md](VERIFY.md) (section 6).

## Use check_payee in your agent (one line each)

Read-only: these never sign and never pay. Concordium **testnet**; `--network mainnet` gives a read-only identity check (never a match).

```sh
npx payonce-check-payee <account> --name "Acme ApS"        # exit 0 match, 1 no match, 2 close match, 3 not possible
npx payonce-check-payee x402 <seller url> --name "Seller"  # read a seller's 402 for free, check its payTo
claude mcp add --transport http payonce https://payonce-api-n98a.onrender.com/mcp   # Claude Code, hosted MCP
claude mcp add payonce -- npx -y payonce-mcp                                        # Claude Code, local stdio bridge
```

Cursor (`.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "payonce": { "command": "npx", "args": ["-y", "payonce-mcp"] } } }
```

GitHub Action (fails the step unless the payee matches):

```yaml
- uses: mohamedwael201193/payonce/packages/check-payee-action@main
  with: { url: https://seller.example/api/paid, name: "Seller Name" }
```

Agent-to-agent: `POST https://payonce-api-n98a.onrender.com/a2a` (JSON-RPC `message/send`, card at `/.well-known/agent.json`).
Pay-per-check over x402 on testnet: `GET /api/x402/check-payee?payee=<account>&name=<name>` answers 402 (0.01 CCD, fee sponsored), then the verdict after payment.
Packages: [payonce-check-payee](https://www.npmjs.com/package/payonce-check-payee) · [payonce-mcp](https://www.npmjs.com/package/payonce-mcp).

## Verify it yourself

Needs Node 22+. Read-only, no keys. The public testnet node rate-limits (HTTP 429): run it again.

```sh
git clone https://github.com/mohamedwael201193/payonce && cd payonce
(cd backend && npm ci) && (cd api && npm ci)
cd api && node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt
# last line, recorded 28 Nov: ALL CHECKS PASS (10/10)
```

Ask the official registry about the three agents (expect `"badge_valid":true` three times):

```sh
for t in JyP9XawpXHMjTN5ocrA5a JyP9Y9nGU4KaM7DBDXRgm JyP9Xp5bhbLsQrw7yTyph; do
  curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/$t?network=testnet" | grep -o '"badge_valid":[a-z]*'
done
```

## On CCDExplorer

| What | Link |
| --- | --- |
| A real CCD payment (payable 10, verifier 10/10) | [`7c204f0b…d73197`](https://ccdexplorer.io/testnet/transaction/7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197) |
| Refused by the chain: unlisted seller, code -19 | [`e8e3d588…7688b5`](https://ccdexplorer.io/testnet/transaction/e8e3d588817c80f58d20589752bf72f61896f8430e95bd880f9b06c6647688b5) |
| 18+ check, request anchored (28 Nov) | [`0cd44ea0…be8ca2`](https://ccdexplorer.io/testnet/transaction/0cd44ea04e380c1bfd23b2fc8c79a7474ac6088d34dedf7159499320be7b8ca2) |
| 18+ check, result anchored | [`bf5a7bf4…c1bb19`](https://ccdexplorer.io/testnet/transaction/bf5a7bf445b53d4b2e62407f55639f2f0b897bc983f223f2cb0491c605c1bb19) |
| Payable registry v2 / v3 | [`<13150,0>`](https://ccdexplorer.io/testnet/instance/13150/0) · [`<13172,0>`](https://ccdexplorer.io/testnet/instance/13172/0) |
| Official CIS-8004 Agent Registry | [`<12802,0>`](https://ccdexplorer.io/testnet/instance/12802/0) |

## Where things are

`contracts/` Rust contracts (v2, v2.1, v3) · `api/` HTTP API, verifier, MCP · `agent/` the agent and its safety guard · `prover/` scoped age prover ·
`frontend/` site and app · `qa/` end-to-end runs and recorded agent runs · [`docs/`](docs): [DETAILS](docs/DETAILS.md), [VERIFIABLE_BUILD](docs/VERIFIABLE_BUILD.md).
Run locally and tests: see `api/README.md` and the test table in DETAILS. License: Apache-2.0.
