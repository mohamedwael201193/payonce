# PayOnce

[![CI](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml) [![status monitor](https://github.com/mohamedwael201193/payonce/actions/workflows/monitor.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/monitor.yml) [![census](https://github.com/mohamedwael201193/payonce/actions/workflows/census.yml/badge.svg?branch=main)](https://github.com/mohamedwael201193/payonce/actions/workflows/census.yml)

**An AI agent checks that the receiving account belongs to the name on the invoice, then pays exactly once.**
The four outcomes are Match, Close match, No match, and Not possible — the same ones EU banks show (Reg 2024/886). Concordium testnet only. No mainnet payments, no real money. Built for the Encode Club × Concordium Trusted Agents Hackathon.

Others check that a payout address is the agent’s registered wallet (for example VeriFlow’s `payTo == agentWallet`, and x402-doctor’s payee check). We check a different thing: that the account belongs to the *name on the invoice*.

**Live:** [60-second demo](https://payonce-tau.vercel.app/demo) · [app](https://payonce-tau.vercel.app/app) · [census](https://payonce-tau.vercel.app/app/proof/census) · [API](https://payonce-api-n98a.onrender.com/api/vop/config) · [CI](https://github.com/mohamedwael201193/payonce/actions/workflows/ci.yml)

A judge path, hard questions and limits: [JUDGES.md](JUDGES.md). Threats and what the chain does *not* verify: [THREAT_MODEL.md](THREAT_MODEL.md). Machine-readable: [llms.txt](llms.txt) (also at `/llms.txt` on the site).

## 60 seconds

Open [/demo](https://payonce-tau.vercel.app/demo). Six screens, one button each: a Match payment, an impostor stopped, the chain refusing a forced pay (`PayeeNotMature`, -29), and a second payment refused on chain (`WrongStatus`, -5). When `GET /api/demo/run` has a fresh run (`live:true`, less than an hour old) you are watching that run; otherwise a labelled replay of a recorded one.

Then, if you have a Concordium testnet wallet (Browser Wallet 2.10+ or CryptoX Android): [/app?dash=1](https://payonce-tau.vercel.app/app?dash=1) is the dashboard (prove your name, become a payee, get paid, pay someone with a verdict). [/app](https://payonce-tau.vercel.app/app) without the flag is the original Run-it page on payable registry v2.

## What is real today, and what is not

| Part | Status (28 Nov 2026) |
| --- | --- |
| `/demo` on the v3 demo book [`<13173,0>`](https://ccdexplorer.io/testnet/instance/13173/0) (90 s cooling-off; a production book would be 24 h+, set at init) | Live. Fresh runs up to 30/day. Stand-in invoice name: “PayOnce Labs” (labelled). |
| Payee book v3 [`<13172,0>`](https://ccdexplorer.io/testnet/instance/13172/0) (600 s cooling-off), verifiable module `8641046e…` | Deployed. The dashboard uses the 90 s demo book. |
| Payable registry v2 [`<13150,0>`](https://ccdexplorer.io/testnet/instance/13150/0) | Still serves the Run-it page (`/app` without `?dash=1`). Not a verified build on CCDExplorer. |
| `check_payee` (`GET /api/vop/check`, `/api/check-payee`) | Live, testnet full check; `network=mainnet` is identity-only (never Match, never payable). |
| Dashboard routes (`/api/payee/propose`, `/api/getpaid`, `/api/p/:account/pay-tx`, `/api/record/:account`) | Live on the demo book. Close match needs `approved=1`. Not possible cannot be acknowledged and is refused. |
| Census of the official registry (`GET /api/census`, [/app/proof/census](https://payonce-tau.vercel.app/app/proof/census)) | Snapshot 28 Nov 2026, 07:26 UTC: at most 5 of 5,501 mainnet agents, and 3 of 1,553 on testnet, meet the *preconditions* of a payee check (an upper bound). |
| x402 services run by other teams | Listed, probed (free), and payable by a capped reference buyer on Match only. |
| PayOnce sells `check_payee` over x402 | Live: `GET /api/x402/check-payee?payee=&name=` answers 402 (0.01 CCD, fee sponsored), then the verdict. A2A `message/send` at `/a2a`. CLI/MCP: `npx payonce-check-payee`, `npx payonce-mcp`. |
| EUDemo rail | The guard runs in our API before the transfer. The contract cannot see tokens. |
| 18+ check | Hosted prover with one PayOnce testnet credential, not the visitor’s wallet. Visitor wallet routes are not live. |
| Human approval of a Close match | A click on the page, with a consent box. A wallet-signed approval is not live yet. |
| Outside users | No visitor outside us has completed “become a payee” yet. |
| Protocol-Level Locks (PLL) | NO-GO for a live demo (DevNet-only, no public IdP, wire format still moving). See `tools/census/PLL_SPIKE.md`. |

The chain enforces the payee’s signature, the cooling-off, the version and pay-once. It does **not** verify the name proof: a keyless verifier anyone can re-run does. Testnet names are self-asserted mock identities.

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

A v2 payment, recorded 28 Nov, 10/10:

```sh
git clone https://github.com/mohamedwael201193/payonce && cd payonce
(cd backend && npm ci) && (cd api && npm ci)
cd api && node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt
# last line, recorded 28 Nov: ALL CHECKS PASS (10/10)
```

A live payee check (expect `UNVERIFIED` unless that account has a proven name equal to the one you pass):

```sh
curl -s "https://payonce-api-n98a.onrender.com/api/check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&legal_name=Nour%20Design%20Studio"
```

Official badge check for our three agents (expect `"badge_valid":true` three times):

```sh
for t in JyP9XawpXHMjTN5ocrA5a JyP9Y9nGU4KaM7DBDXRgm JyP9Xp5bhbLsQrw7yTyph; do
  curl -s "https://agent-registry-mcp.concordium.com/v1/badge-check/$t?network=testnet" | grep -o '"badge_valid":[a-z]*'
done
```

## On CCDExplorer

| What | Link |
| --- | --- |
| Fresh `/demo` Match payment (demo book, 28 Nov) | [`9017c75b…c2b08e`](https://ccdexplorer.io/testnet/transaction/9017c75b83b15c4bd19572af2ae86bf3f8ad8cf426f1de3c318d4b076cc2b08e) |
| Impostor forced, chain refused -29 PayeeNotMature | [`6bfe195c…654ced`](https://ccdexplorer.io/testnet/transaction/6bfe195c14a8d82295b4a127fb3ab634a27761ce92f7f12aee063b9ff0654ced) |
| Second payment refused -5 WrongStatus | [`d91e7611…ccb021`](https://ccdexplorer.io/testnet/transaction/d91e7611d894d88092d600e97c83e3c9c08cc9d94a8ca0e423348b92f9ccb021) |
| A v2 CCD payment (payable 10, verifier 10/10) | [`7c204f0b…d73197`](https://ccdexplorer.io/testnet/transaction/7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197) |
| Demo book v3 / payee book v3 / v2 | [`<13173,0>`](https://ccdexplorer.io/testnet/instance/13173/0) · [`<13172,0>`](https://ccdexplorer.io/testnet/instance/13172/0) · [`<13150,0>`](https://ccdexplorer.io/testnet/instance/13150/0) |
| Official CIS-8004 Agent Registry | [`<12802,0>`](https://ccdexplorer.io/testnet/instance/12802/0) |

## Where things are

`contracts/` Rust contracts (v2, v2.1, v3) · `api/` HTTP API, verifier, MCP · `agent/` the agent and its safety guard · `prover/` scoped age prover ·
`frontend/` site and app · `qa/` end-to-end runs · [`docs/`](docs): [DETAILS](docs/DETAILS.md), [VERIFIABLE_BUILD](docs/VERIFIABLE_BUILD.md).
License: Apache-2.0.
