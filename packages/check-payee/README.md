# payonce-check-payee

**Verification of Payee for AI agents on Concordium.** Before an agent pays an account, ask who the account really is.
Zero dependencies. It never signs and never pays.

> Status: prepared in the public repo, **not published to npm yet**. Run it from a clone: `node packages/check-payee/bin/cli.mjs …`.
> Concordium **testnet**. Testnet names are self-asserted mock identities. The chain does not verify the zero-knowledge proof; a keyless verifier does.

## Four outcomes

| Verdict | Outcome | What the agent does | Exit code |
|---|---|---|---|
| `MATCH` | match | pay once, to this account only | 0 |
| `NO_MATCH` | no match | pay nothing | 1 |
| `CLOSE_MATCH` | close match | stop, a person decides | 2 |
| `UNVERIFIED` | verification not possible | stop, a person decides (this is not a match) | 3 |

An agent pays only the account whose proven name matches the name it was told to pay.

## CLI

```sh
# an account and the name on the invoice
check-payee 3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ --name "Acme ApS"

# an x402 seller: read its 402 for free, then check its payTo (nothing is paid)
check-payee x402 https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k --name "Oracle Scout"

# the public payee card (the /p/<account> link)
check-payee card 3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ
```

`--json` prints the full result. `--api <url>` or `CHECK_PAYEE_API` points at another API (default: the hosted PayOnce API).
Exit codes: 0 match, 1 no match, 2 close match, 3 verification not possible, 64 usage, 70 error.

## Library

```js
import { checkPayee, probeX402 } from 'payonce-check-payee';
const r = await checkPayee({ payee: account, name: 'Acme ApS' });
if (r.action === 'pay') { /* MATCH: pay once */ } else if (r.action === 'ask_human') { /* ask a person */ } else { /* refuse */ }
```

## MCP

The hosted MCP server (Streamable HTTP, read-only) at `https://payonce-api-n98a.onrender.com/mcp` lists `check_payee`,
`check_x402_seller` and `get_payee_card` next to the invoice tools. Add it to any MCP client by URL.

## GitHub Action

```yaml
- uses: mohamedwael201193/payonce/packages/check-payee-action@main
  with:
    url: https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k   # or: payee: <account>
    name: Oracle Scout
    fail-on: no_match            # default fails on anything that is not a match
```

Outputs: `verdict`, `outcome`, `action`, `pay-to`, `price-ccd`.

## What it does not do

It does not hold keys and does not pay. An outside seller whose account has no name proof comes back `UNVERIFIED`, which is
honest: verification is not possible, so a person decides.
