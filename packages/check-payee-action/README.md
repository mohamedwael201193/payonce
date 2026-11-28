# PayOnce check_payee (GitHub Action)

Fail a workflow before an agent pays the wrong account. Reads an x402 seller's 402 **without paying** (or checks an account you name)
and runs Verification of Payee on the account that would be paid. No wallet, no secrets. Concordium testnet.

```yaml
jobs:
  vop:
    runs-on: ubuntu-latest
    steps:
      - id: vop
        uses: mohamedwael201193/payonce/packages/check-payee-action@main
        with:
          url: https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k
          name: Oracle Scout
          fail-on: no_match
      - run: echo "outcome ${{ steps.vop.outputs.outcome }} pay-to ${{ steps.vop.outputs.pay-to }} price ${{ steps.vop.outputs.price-ccd }} CCD"
```

| Input | Meaning |
|---|---|
| `url` or `payee` | an x402 seller URL, or a Concordium account |
| `name` | who you meant to pay |
| `fail-on` | outcomes that fail the step: `no_match`, `close_match`, `not_possible` (default all three) |
| `method`, `body` | for POST sellers |

Outcomes: **match** (pay once), **close_match** (a person decides), **no_match** (pay nothing), **not_possible** (a person decides).
The repo's own CI runs this action against another team's live seller (Oracle Scout). That seller's account has no name proof, so the
honest answer is `not_possible`, and the CI step asserts exactly that.
