# PayOnce for judges

Concordium testnet only. Every claim below is something you can open or run. A fuller threat list is in [THREAT_MODEL.md](THREAT_MODEL.md). The README is the live-state table.

**The idea.** Before an agent pays anyone, it checks that the *receiving account* belongs to the *name on the invoice*. The four outcomes are Match, Close match, No match, and Not possible (EU VoP, Reg 2024/886). The agent itself pays only on Match, and only once.

Others already check that a payout address is the agent’s registered wallet (VeriFlow check 5, `payTo == agentWallet`; x402-doctor `x402_payee_check`). We check a different object: the name the buyer was told to pay, against the account that would receive the money.

## 60-second path

1. Open https://payonce-tau.vercel.app/demo (no wallet).
2. Click through six screens. You should see a Match payment, an impostor stopped, a chain refusal if the agent is forced (`PayeeNotMature`, -29), and a second payment refused on chain (`WrongStatus`, -5).
3. The footer says whether this is a fresh run (`GET /api/demo/run`, `live:true`, less than an hour old) or a labelled replay. The invoice name “PayOnce Labs” is a labelled testnet stand-in.

Optional, still under a minute: https://payonce-tau.vercel.app/app/proof/census (upper bound: at most 5 of 5,501 mainnet agents meet the *preconditions* of a payee check, snapshot 28 Nov 2026 07:26 UTC) and https://payonce-tau.vercel.app/p/4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin (a live check; expect Not possible / Unverified unless you pass a proven name).

## Five-minute tour

| Open | You will see |
| --- | --- |
| [/demo](https://payonce-tau.vercel.app/demo) | The whole idea, ~60 s, real transactions when the run is live. |
| [/app](https://payonce-tau.vercel.app/app) | Run-it on payable registry v2 `<13150,0>`: load an invoice, Match / No match, pay once. |
| [/app?dash=1](https://payonce-tau.vercel.app/app?dash=1) | The dashboard on the v3 demo book `<13173,0>` (90 s cooling-off). Needs a testnet wallet (Browser Wallet 2.10+ or CryptoX Android). Sponsored fees. |
| [/app/sell](https://payonce-tau.vercel.app/app/sell) | Become a payee: register, prove the name, issue an invoice, watch the agent pay it. |
| [/app/proof](https://payonce-tau.vercel.app/app/proof) | Evidence: the agent’s last run, “Try to fool it”, 18+, keyless verifier, census, x402. |
| [`9017c75b…`](https://ccdexplorer.io/testnet/transaction/9017c75b83b15c4bd19572af2ae86bf3f8ad8cf426f1de3c318d4b076cc2b08e) | A live `/demo` Match payment. |
| [`6bfe195c…`](https://ccdexplorer.io/testnet/transaction/6bfe195c14a8d82295b4a127fb3ab634a27761ce92f7f12aee063b9ff0654ced) | Impostor forced; the chain refused -29. |
| [GET /api/vop/config](https://payonce-api-n98a.onrender.com/api/vop/config) | Contract, verdicts, reject codes -28..-36. |
| [GET /api/census](https://payonce-api-n98a.onrender.com/api/census) | The census JSON the page renders (upper bound, definitions, wording block). |

The v3 module on `<13172,0>` / `<13173,0>` is a verifiable build (`8641046e…`, CCDExplorer “Verified”). v2 is not.

## Ten hard questions

1. **“No rival checks the receiving account.”** That wording is false. VeriFlow checks that `payTo` equals the on-chain `agentWallet`. x402-doctor checks whether a payTo is bound to the seller’s agent. Our unique claim is narrower and true: we check that the receiving account belongs to the *name on the invoice*, with the four EU outcomes.

2. **Does the chain verify the zero-knowledge name proof?** No. The chain enforces the payee’s signature, the cooling-off, the version and pay-once. The name proof is checked by a keyless verifier anyone can re-run. A CCD contract cannot verify a ZK proof today.

3. **Are testnet names real identities?** No. They are self-asserted mock identities. “PayOnce Labs” is a labelled stand-in name on the demo book, not a company proof. A real Match for an outside company needs a Global FinReg business identity and a payee-signed name binding; nobody outside PayOnce has that today.

4. **Is one friend “use”?** No. Use means someone we do not operate completed the flow with their own wallet. We have not claimed that. No visitor outside us has completed “become a payee” yet.

5. **Why is there no escrow or refund window?** We do not hold funds. A payment goes straight to the bound payee in the same transaction; a refund window would mean taking the money first. After a payment has landed, the contract has no exit (`void_payable` refuses a Paid row). Recourse is prevention: the name check, the cooling-off, and `void_payable` cancelling a reserved invoice *before* it is paid. Shown on [/app/proof/break](https://payonce-tau.vercel.app/app/proof/break).

6. **What does a payment cost?** In the fresh `/demo` run of 28 Nov 2026, the sponsored Match payment cost about 20.36 testnet CCD in network fees, paid by PayOnce’s sponsor, not the new account. Fees vary. They are testnet fees, not an estimate for any other network. The demo book’s cooling-off is 90 s so a judge can watch it; a production book would be 24 h+, set at init.

7. **Do you pay on mainnet?** No. `GET /api/vop/check?network=mainnet` is identity-only: never Match, never payable (there is no mainnet payee book). The census is a read-only count of registry preconditions.

8. **Can a person override a Close match?** The contract’s `acknowledge_payee` accepts Close match. The agent itself pays only on Match. On the dashboard, a Close match can be paid from the visitor’s wallet after they tick a consent box (`approved=1` on `/api/p/:account/pay-tx`). That approval is a click, not a wallet signature (not live yet). Not possible cannot be acknowledged; the chain would refuse -36, so nothing is offered to sign. No match has no override.

9. **Protocol-Level Tokens / Locks?** EUDemo (a testnet demo token, not a euro stablecoin) is guarded in our API; the contract cannot see tokens. Protocol-Level Locks are a NO-GO for a live demo: DevNet-only, no public identity provider, wire format still moving. Evidence: `tools/census/PLL_SPIKE.md`.

10. **Do you pay other teams’ x402 services?** The reference buyer lists live sellers, probes for free, and pays only on Match, under a 2.5 CCD cap, labelled as PayOnce’s buyer. A Close match asks a person first. We do not call those sellers “verified” or “safe”.

## Commands

```sh
# Fresh demo run (live:true when < 1 h old)
curl -s https://payonce-api-n98a.onrender.com/api/demo/run | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['live'], d.get('paid',{}), d.get('impostor',{}).get('refusal'))"

# A payee check
curl -s "https://payonce-api-n98a.onrender.com/api/check-payee?payee=4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin&legal_name=Nour%20Design%20Studio"

# Keyless v2 payment verifier (Node 22+; public node may 429)
cd api && node src/verify-payable-v2.mjs 10 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197 --doc ../backend/test/invoices/invoice-010-v2-ccd.txt
```
