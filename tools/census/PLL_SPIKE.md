# Protocol-Level Locks (PLL) spike — PayOnce — 28 Nov 2026 (Cairo, UTC+2)

## Verdict: NO-GO for a live lock demo before 9 Dec (as of 28 Nov). GO for a "lock-ready" design statement.

## What a Simple Lock is (official sources)
- Workshop 4 (Doris Benda): Simple locks = recipients, tokens (PLTs only, not CCD), expiry, grants
  (fund/send/release/cancel), optional keep-alive + metadata. Funds stay in the owner's account; the
  agent can only send them to listed recipients. "Already on DevNet to try"; testnet/mainnet targeted Jan 2027;
  Enhanced (smart-contract-driven) locks March 2027 (workshops analysis L438-442).
- Town Hall #6: "landing in testnet in December … January 27th will be when we've got the locks on mainnet"
  (youtube transcripts L603; consolidation notes L53).
- Code: concordium-base branch `release/p11` (HEAD be424f8, 27 Nov 2026)
  `rust-src/concordium_base/src/protocol_level_locks/lock_config_simple_v0.rs`: `SimpleLockConfigV0 {recipients,
  holders, expiry, roles, tokens, metadata}`; capabilities `release|send|cancel` (fund implicit for holders).
- JS SDK `@concordium/web-sdk@13.0.0-alpha.2` (npm tag `alpha`): `LockConfig.simpleV0(recipients, expiry, grants,
  tokens, …)`, error `RecipientNotAllowedError` = "The recipient is not among the lock's configured recipients".
  So the primitive we want (protocol refuses a send to a non-listed payee) is exactly what Simple locks do.
- Concordium/ccd-agent-kit (23 Nov) `build_plt` supports `lock_create|lock_fund|lock_send|lock_cancel|lock_release`
  ("Protocol 11 lock release uses operation type lock_release"). Concordium/concordium-dapp-examples has a `locks/` dApp.

## Is it on DevNet now? Yes — P11 DevNet is live
- `GET https://wallet-proxy.devnet-p11-1.concordium.com/v0/consensusInfo` → protocolVersion 11, genesis
  b38a368d92b58fe3cbed54b6624ac757ed236853e756db41b46861c312bc3cbb (testnet and mainnet both report protocolVersion 10).
- gRPC node: `grpc.devnet-p11-1.concordium.com:20000` (Agent Registry MCP `network_status devnet`). Registry CIS-8004 `<32,0>`.
- REST that works from the box: wallet-proxy (devnet/testnet/mainnet) incl. `PUT /v0/submitRawTransaction`,
  `/v0/submissionStatus/{hash}`, `/v3/accTransactions`, `/v0/plt/tokens`; hosted Agent Registry MCP + REST
  (`agent-registry-mcp.concordium.com`); agent-registry-indexer `/status`; ccdexplorer.io HTML pages.
- What does NOT work from the box: any gRPC on :20000 (testnet, mainnet, devnet). TLS handshake completes then the
  egress proxy drops it (no ALPN h2). Use the wallet-proxy or the hosted MCP instead, or run gRPC tools from momo's PC.

## Why NO-GO (blocking facts)
1. No way to get a DevNet account on our own. DevNet identity providers are placeholders "Generated IP 0/1/2" with
   no issuance URL (`/v2/ip_info`). The Concordium faucet/wallet flow does not cover devnet-p11-1.
2. No PLT we can hold. Locks are PLT-only. DevNet has 5 PLTs (Token1/2/3, EHG, EG0), all governed by Concordium
   staff accounts; PLT creation is a chain-governance update (`createPlt` authorization), not an account transaction.
3. The wire format is still changing. Base `release/p11` (27 Nov) has a `holders` field and implicit `fund`; SDK
   13.0.0-alpha.2 has `grants` with `fund` and no `holders`. Earlier alphas used `return` (now `release`). Anything
   we build now may break before judging, and judges cannot reproduce it.
4. Discord #dev-support (18 Jun 2026, L2130-2135): "Any eta on when PLT and PLL txs will be added to devnet-P11-2?" —
   staff escalated; no public answer in the export. DevNet participation is by Concordium invitation/form (L2037).
5. Local P11 chain is possible in theory (stagenet-node 11.2.2-1 image, Jun 2026) but that image predates the
   current lock format and genesis-creator P11 support is unverified. Judges couldn't verify the hashes anyway. Not worth it.

## Only way to flip to GO (owner action, external)
Ask Concordium for a DevNet-P11 account plus a few units of a PLT (e.g. Token1/EG0) or a test PLT with us as holder.
If granted by ~3 Dec: 1 day to run lock_create(recipients=[VoP-verified payee], tokens=[PLT], expiry=due date,
send grant=agent) → lock_send to the verified payee (success) → lock_send to an unverified payee (protocol reject,
RECIPIENT_NOT_ALLOWED), all via wallet-proxy submitRawTransaction. Label it "DevNet-P11, preview".

## What to say in the go-live plan instead (honest, judge-safe)
"Today PayOnce enforces Verification of Payee in its v3 contract on testnet: a payment can only reach a payee whose
business identity matched the invoice, and a changed payee is held by a cooling-off period. When Simple Protocol-Level
Locks reach testnet (Dec) and mainnet (target 27 Jan 2027), the same verified payee list becomes the lock's
`recipients`, the invoice due date its `expiry`, and the agent gets only the `send` grant: the funds never leave the
owner's account, and the protocol itself refuses a send to any payee that is not verified. We checked this against
the P11 code (concordium-base release/p11, web-sdk 13.0.0-alpha.2 `RecipientNotAllowedError`) and confirmed P11 is
live on DevNet, but we do not claim a lock transaction: no public DevNet accounts or PLTs exist yet."
