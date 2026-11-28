# Part 3: further differentiators (max 5, ranked)

Written 28 Nov 2026 (Cairo). Basis: `/workspace/story/FINAL_STORY.md` (levers E1–E6, F/R screens, WS lanes), the census (`METHOD.md`), the judges' R1 notes and the workshop/Discord analyses.
**Criteria** (official, equal weight, as used by Judge A): **D** = Depth of ID / Registry / agent-pay integration · **M** = Mainnet path and real users · **E** = End-to-end working · **P** = Real problem.
**Effort**: S = under half a day, M = 1–2 days, L = 3+ days. Rank = (score gain × how well it uses what already exists) ÷ effort. Every item is testnet-write or mainnet-read-only.

Where we stand (Judge A R1, PayOnce 9be3793): D 8.0 · **M 5.5** · E 8.0 · P 8.5. M is the weak criterion and the field leaders are strong on it (VeriFlow 8.5). So the ranking favours **M** first.

| # | Differentiator | Criteria moved | Effort | Story fit |
|---|---|---|---|---|
| 1 | Mainnet public payee check: one page, one MCP/Action option, same four verdicts | **M** (+1.5), P | **S** (API done; page + MCP flag left) | E1/E5 |
| 2 | Payee-change feed: "bank details changed" on the whole registry, every 6 h | **P**, D | **S** (data path done; page card left) | F4 / E1 |
| 3 | Make-an-x402-seller-verifiable in 3 minutes (self-signed binding + `/p/` page), then re-run the census live | **M** (real users), E | **M** | R2 / R4(b) / E2 |
| 4 | Verdict receipts anchored on chain (`registerData` of `evidence_hash`) | **D**, E | **M** | R5 / "verify it yourself" |
| 5 | A published VoP spec: EPC-shaped response, JSON schema, conformance tests, EU rule mapping | P, D | **S** | Pitch line / go-live plan |

## 1. Mainnet public payee check (rank 1)
- **What.** Anyone pastes a mainnet account (or an x402 URL, we read its `payTo`) into `/app/proof/check` and gets MATCH / CLOSE_MATCH / NO_MATCH / UNVERIFIED with reasons and an `evidence_hash`. Backend: `GET /api/vop/check?network=mainnet` (shipped, identity-only, never MATCH, never payable, labelled). Left: the page (WS2), `network` argument on the hosted MCP tool and the GitHub Action (WS3).
- **Why it scores.** M is our worst criterion (5.5). A read-only mainnet path that returns real answers on real accounts (5,492 active mainnet agents; one account with a business identity holds the 5 that can pass) is the cheapest honest M gain. It also answers VeriFlow's `check_seller` on mainnet with a different object: the **receiving account**, not the seller's badge.
- **Evidence it is needed.** Census: 1,995 mainnet agents hold a valid badge, but only 5 have a payee with a business identity (upper bound). Workshop evidence that badge validity is not assumed: "only 4 of 148 registered agents were valid in Doris's live test" (workshops analysis §3.23).
- **Risk.** Overclaiming. Mitigation: the response says `mode: identity_only`; the page says "UNVERIFIED is the honest answer for almost every mainnet account today".

## 2. Payee-change feed (rank 2)
- **What.** The census job already runs every 6 h and commits its data. Each run keeps the previous agent list and publishes `changes_since_previous_run` in `census_public.json`: new agents, removed agents, and **tokens whose `agentWallet` (the payee) changed** (with from / to, and whether the owner stayed the same). The page shows "N payee changes in the last 6 h", the on-chain form of "our bank details changed" (the FinalStory F4 impostor).
- **Why it scores.** P (real problem: BEC fraud is a payee-change attack), D (uses registry state, not just a badge). Git history of the data folder doubles as an audit log nobody else has. Cost is near zero.
- **Honest limit.** Registry state only: a changed agentWallet is a *signal*, not proof of fraud. The wording is "changed", never "fraudulent". Zero changes is a valid, boring result: show it as such.

## 3. Make an x402 seller verifiable in 3 minutes, then re-run the census (rank 3)
- **What.** A seller opens `/app/sell`, proves its name (person or company), signs the payee binding, and gets `/p/<account>` plus a snippet for its 402 response (`payTo` + a link to the binding). Re-run the x402 part of the census: the seller flips from UNVERIFIED to MATCH on testnet. Before / after is the demo.
- **Why it scores.** M (a real outside party using the rail), E (full loop on chain), and the only item that changes the census numbers instead of reporting them. FINAL_STORY E2 asks for exactly this (≥5 friends, ≥2 companies, ≥3 outside purchases).
- **Evidence.** All 5 Concordium x402 sellers found are UNVERIFIED today; none has a payee-book binding. Nobody outside PayOnce can be MATCH.
- **Dependency.** WS1 sponsored `accept_payee` (D1 gate) and momo's friends (needs from momo). If the gate fails, fall back to the labelled starter drop.

## 4. Verdict receipts anchored on chain (rank 4)
- **What.** After a `check_payee` that leads to a payment, the agent attaches the `evidence_hash` as `registerData` (or the PLT memo) to the payment. `/receipt/*` shows "verdict hash X is on chain at tx Y", and the existing verifier recomputes the hash from public inputs.
- **Why it scores.** D (uses a native Concordium feature; W4 said registerData was "created exactly for that kind of use case", workshops L470) and E (verifiable by a judge with one command).
- **Honest limit.** It proves *what the agent saw and when*, not that the verdict was right.

## 5. A published VoP spec for agents (rank 5)
- **What.** `docs/VOP_SPEC.md` + `vop-response.schema.json`: the four outcomes in the EPC scheme order (Match, Close match with the suggested name only on close match, No match, Not possible), required evidence fields, mainnet identity-only mode, and 12 conformance tests anyone can run against any `check_payee` implementation. A short table maps each outcome to the EU instant-payments rule (**verify the exact citation, Reg. (EU) 2024/886, before printing it**).
- **Why it scores.** P (shows the problem is regulatory, not invented) and D. Cheap, and it turns "PayOnce is a project" into "PayOnce is the reference implementation of a rail", which is the open-rail moat in the story.

## What I would not do
- **Protocol-Level Locks** as a feature: NO-GO (see `PLL_SPIKE.md`; DevNet P11 only, no production PLT).
- **Any mainnet write.** The mainnet path stays read-only; mainnet MATCH is not claimed anywhere.
- **Percent headlines on 5 x402 sellers.** Quote counts.

## Suggested order inside the 10-day plan
D2 (Mon 30): rank 1 page + MCP flag, rank 2 card. D4–D6: rank 3 with the friends. D6: rank 4 (needs WS1). D8: rank 5 as docs. Re-run the census (auto, every 6 h) before each recording.
