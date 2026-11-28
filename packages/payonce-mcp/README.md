# payonce-mcp

Stdio **MCP server** for PayOnce's **Verification of Payee** on Concordium **testnet**. Add it to Claude Desktop, Cursor or any MCP client.
It is a zero-dependency bridge to the hosted endpoint `https://payonce-api-n98a.onrender.com/mcp`. **Read-only: it never pays.**

```json
{ "mcpServers": { "payonce": { "command": "npx", "args": ["-y", "payonce-mcp"] } } }
```

Tools: `check_payee` (MATCH / CLOSE_MATCH / NO_MATCH / UNVERIFIED), `check_x402_seller` (reads a seller's 402 for free and checks its payTo),
`get_payee_card`, plus `list_payables`, `check_payable`, `receipt`.

Rule for the agent: pay only on MATCH. A person decides on CLOSE_MATCH and on "verification not possible". Never pay on NO_MATCH.
Testnet names are self-asserted mock identities; the chain does not verify the zero-knowledge proof, a keyless verifier does.

Env: `PAYONCE_MCP_URL` to point at another deployment. Source: github.com/mohamedwael201193/payonce/tree/main/packages/payonce-mcp. Apache-2.0.
