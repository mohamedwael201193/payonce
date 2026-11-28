# PayOnce on the official Concordium Agent Registry (testnet)

Registry: CIS-8004 `<12802,0>` (linked CIS-8 `<12801,0>`), chain `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
Badge check: Concordium's own endpoint `https://agent-registry-mcp.concordium.com/v1/check-badge/{badge}?network=testnet`.
Last full check: **28 Nov 2026, 10:3x Cairo (08:3x UTC)**. Raw output for all four: [`docs/evidence/registry-badge-check.json`](evidence/registry-badge-check.json).

| Agent | Token | Badge | Official check | Agent card (our domain) | agentWallet (bound by that wallet's own signature) |
|---|---|---|---|---|---|
| PayOnce Seller | 1476 | `JyP9XawpXHMjTN5ocrA5a` | badge_valid **true**, 15/15, no issues | [/.well-known/registry/payonce-seller.v3.json](https://payonce-tau.vercel.app/.well-known/registry/payonce-seller.v3.json) | `42jaZZ…` (the payout account the v3 book pays) |
| PayOnce Buyer (payer) | 1488 | `JyP9Xp5bhbLsQrw7yTyph` | badge_valid **true**, 15/15, no issues | [/.well-known/registry/payonce-buyer.v3.json](https://payonce-tau.vercel.app/.well-known/registry/payonce-buyer.v3.json) | `4MvdME…` (the account that pays) |
| PayOnce Seller 2 | 1506 | `JyP9Y9nGU4KaM7DBDXRgm` | badge_valid **true**, 15/15, no issues | [/.well-known/registry/payonce-seller2.v3.json](https://payonce-tau.vercel.app/.well-known/registry/payonce-seller2.v3.json) | `3ARQvc…` |
| PayOnce check_payee (service) | **1554** (new) | `JyP9UE8M6sTcxSaorAr8W` | badge_valid **true**, 15/15, no issues | [/.well-known/registry/payonce-check-payee.v1.json](https://payonce-tau.vercel.app/.well-known/registry/payonce-check-payee.v1.json) | `42jaZZ…` |

Check any of them yourself:

```bash
for b in JyP9XawpXHMjTN5ocrA5a JyP9Xp5bhbLsQrw7yTyph JyP9Y9nGU4KaM7DBDXRgm JyP9UE8M6sTcxSaorAr8W; do
  curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/$b?network=testnet" | jq '{token_id, badge_valid, issues}'
done
```

## Transactions (testnet, 28 Nov 2026)

| What | Token | Tx |
|---|---|---|
| register (mint) the check_payee service agent | 1554 | [`cd28ff9c…`](https://ccdexplorer.io/testnet/transaction/cd28ff9c2c0adc93754767d350a0e27b8ea8448c4df7d9d293581a8839609db4) |
| setAgentURI: card moved to `/.well-known/registry/` with its SHA-256 | 1476 | [`99c9365d…`](https://ccdexplorer.io/testnet/transaction/99c9365d48db435b3469071965e5fb11dc0973e93aa481dbf8c55aa69dacad97) |
| setAgentURI | 1488 | [`1af3139e…`](https://ccdexplorer.io/testnet/transaction/1af3139e37cf1aa8cf7588ac3444305596304cfad2a6092c950ec4380ded3dd5) |
| setAgentURI (was a GitHub gist; now our domain) | 1506 | [`958a979c…`](https://ccdexplorer.io/testnet/transaction/958a979c0c49e2c6a5c43a91412d13aba87f92acbc0c5f41ce6cc0d3392e1e41) |
| setAgentURI | 1554 | [`8bf3d8e8…`](https://ccdexplorer.io/testnet/transaction/8bf3d8e81afb7f478a602faf594ceda6cfd1b9215a0991f11abd049ae9a265bc) |
| setAgentWallet, signed by the wallet account | 1476 | [`c9cf25d1…`](https://ccdexplorer.io/testnet/transaction/c9cf25d1b7d18d609088a76512739be210dbd94aa3001b61c5505c184ba452d8) |
| setAgentWallet, signed by the wallet account | 1488 | [`55a3f768…`](https://ccdexplorer.io/testnet/transaction/55a3f768a582215441d0a9f77af29d75a5ca4a462069f6e85133f54133a40712) |
| setAgentWallet, signed by the wallet account | 1506 | [`144c198a…`](https://ccdexplorer.io/testnet/transaction/144c198ac84e745fa9b427e0456a8a75bb2fdcb48d7e1afad69148bc7c85a82c) |
| setAgentWallet, signed by the wallet account | 1554 | [`e955968e…`](https://ccdexplorer.io/testnet/transaction/e955968e207677d37d0673c6685b4b2ea61b954cbbc17549609fb00cf18d13d3) |

All sent once by `api/scripts/registry-publish.mjs` (Render one-off job). Each was dry-run with `invokeContract` first. Payloads came from the registry's own MCP `build_*` tools, which hold no keys.

## What "agentWallet bound" means here

The registry sets `agentWallet` to the owner when an agent registers, so in most of the registry it is only the default. The census calls this out (`payee_equals_owner_default`). For each PayOnce agent we then sent an explicit `setAgentWallet`:
- the **wallet account itself** signed the 162-byte canonical message `CIS-8004/v1/setAgentWallet` (token id, owner, wallet, nonce, deadline, contract, genesis hash), checked byte by byte before signing;
- the owner sent the transaction;
- the registry's `wallet_set_nonce` went from 0 to 1 for all four (`get_agent_wallet_nonce`), and each token's history has an `AgentWalletSet` event from that transaction.

Each wallet is the account money really moves through. For the sellers, it is the payout account the payable book pays. For the buyer, it is the account that pays: the seller-side gate checks Active + owner + agentWallet against it before payment. We did not point the agentWallet at a different account. That would break the rule that the agentWallet is the account that really pays or gets paid.

## Cards

The cards are built by `tools/registry/build_cards.py`. The registry MCP (`build_agent_badge`) injects the Concordium Badge extension and the ERC-8004 `registrations` entry, and the cards are served byte for byte from `frontend/public/.well-known/registry/`. Pinned files never change. A new version means a new file name and a new `setAgentURI`. `api/test/registry-cards.test.mjs` fails if the bytes stop matching `tools/registry/plan.json` (= the on-chain metadata hash). The older `/.well-known/agent-card*.json` files are kept for old links but are no longer the on-chain URIs.

## Not done

- **CIS-8 external keys** (`<12801,0>` `registerExternalKey`): PayOnce's agents sign with their Concordium account keys and have no non-Concordium (Ethereum/Solana/Fetch.ai) key to bind, so there is nothing true to register. The badge check expects the CIS-8 contract reference in the card (done, `contracts.cis8`), not a key registration.
- Account `3okVZT…` (Browser Wallet QA account) also owns a valid badge, token 1553, made through the dashboard's own registration flow. It is a QA agent, not one of the four above.
