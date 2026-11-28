# Outreach drafts (DRAFTS ONLY, nothing was sent)

For momo to review and edit. Send from your own account, only after you approve each one. They are short on purpose,
state only what we measured, and ask for one small thing. Facts below come from the live check on 28 Nov (Cairo):
every outside x402 seller we checked answers **UNVERIFIED** ("verification not possible"): the payTo account is backed by a
personal identity (provider 0) and has presented no name proof. That is not an accusation; nobody had a way to prove a name before.

Before sending, re-run the one-liner so the numbers are current:
`node packages/check-payee/bin/cli.mjs x402 <url> --name "<seller name>"`

Where to send is not known from our data: use the contact on each team's project page, Encode Club/Discord handle, or GitHub issues.
The task listed five sellers but named four; the fifth is not identified here (candidates seen earlier: ClearToPay, vet402). Tell me which and I will add a draft.

---

## 1. Oracle Scout (agent #1253)
- Seller URL: https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k, payTo `3u319bYkSSU3CeoMqyzt5nd72VpL5qF4oqmZoVTQQPLdBEqyL1`, 2 CCD
- Where: their hackathon submission page / Discord / repo issues

> Subject: Bought your evidence pack, and a 2-minute idea for your payTo
>
> Hi Oracle Scout team, I'm Mohamed from PayOnce (Concordium Trusted Agents hackathon). Our reference agent bought your rehearsal-btc-150k pack for 2 CCD on testnet and got the pack back, tx 8f234571542d7ba95cb6db5d5f59e913d467dce6634d3b67e8053a075d718434. Thanks, it worked first time.
>
> One thing we measured: before paying, our agent asks "does the account in your 402 belong to the name I meant to pay?". For your payTo (3u319bYk…) the honest answer is "verification not possible", because the account has no name proof, so a careful agent has to ask a person. If you open https://payonce-tau.vercel.app/app/sell, connect the wallet that owns that account and prove your name (about 2 minutes, zero-knowledge, nothing else is revealed), the same check will say Match and agents can pay you with no human in the loop.
>
> Also free: A CLI and a GitHub Action (not on npm yet, runnable from the repo) that check any x402 seller's payTo (packages/check-payee in github.com/mohamedwael201193/payonce). Happy to help if anything is unclear. Testnet only, names are self-asserted mock identities; I'm not claiming more than that.

## 2. MainsMarker (agent #990)
- Seller URL: https://mainsmarker.sites.tab.bot/x402/review, payTo `4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2`, 0.5 CCD

> Subject: Bought a review from MainsMarker, and a name check for your payTo
>
> Hi MainsMarker team, I'm Mohamed from PayOnce. Our reference agent paid your /x402/review 0.5 CCD on testnet and received the review, tx 764d8ccb5978f3c0ca1c3e44ec6360baaa6df82418bb8639e6d9ed1eabc8ccab. Nice, clean x402 flow.
>
> We run a "Verification of Payee" check before an agent pays: does the payTo account belong to the name we meant to pay? For 4J2SFgeV… it answers "verification not possible" (personal identity, no name proof). If you prove your name from your wallet at https://payonce-tau.vercel.app/app/sell (about 2 minutes, zero-knowledge), agents will see Match for MainsMarker and can pay without asking anyone.
>
> You can also run the check yourself: `check-payee x402 <your url> --name MainsMarker` (packages/check-payee in github.com/mohamedwael201193/payonce). Testnet, mock identities; no overclaiming.

## 3. SentinelAgent
- Seller URL: https://api.sentinelagent.pro/x402/verdict, payTo `4XB5Fr1jgcp9SuqTQQwyfiY7L6CncUQuvG1dY83ASpN9S4ZDhh` (1 CCD); a second 402 option for EUDemo uses `47jp7qLd…`
- We have **not** bought from them.

> Subject: Verification of Payee for your /x402/verdict (and a possible integration)
>
> Hi SentinelAgent team, I'm Mohamed from PayOnce. Your compliance verdicts are exactly what an agent wants before it pays, so I'd like to suggest the other direction too: before a buyer pays you, it can check who your payTo is.
>
> We read your 402 (no payment) and ran check_payee on 4XB5Fr1j…: "verification not possible", since the account has a personal identity and no name proof. Proving "Sentinel" (or your legal name) from your wallet takes about 2 minutes at https://payonce-tau.vercel.app/app/sell and turns that into Match.
>
> If it's useful, your verdict endpoint could also call our check_payee (GET https://payonce-api-n98a.onrender.com/api/check-payee?payee=<account>&legal_name=<name>, or the MCP tools on /mcp) as one more signal. Zero keys, testnet. I'm happy to help wire it.

## 4. VeriFlow (a peer team, handle with care)
- Seller URL: https://veriflow-yrhp.onrender.com/signal/BTC, payTo `3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8`, 1 CCD
- We have **not** bought from them. They are a direct competitor, so keep it factual and collegial.

> Subject: Two checks that fit together: seller identity (yours) and payee name (ours)
>
> Hi VeriFlow team, I'm Mohamed from PayOnce. Your guard checks that the seller's agent, card hash and payTo wallet line up in the registry. We check a different thing: whether the payTo account belongs to the *name* the buyer meant to pay (a zero-knowledge name proof, MATCH / CLOSE_MATCH / NO_MATCH / not possible). They compose: yours says "this is the registered agent's wallet", ours says "and the account's proven name is X".
>
> Two small offers: (1) prove your name from the payTo wallet at https://payonce-tau.vercel.app/app/sell so `check-payee x402 https://veriflow-yrhp.onrender.com/signal/BTC --name VeriFlow` returns Match instead of "not possible" (today: personal identity, no name proof); (2) if you like, call check_payee as an optional extra check in concordium-x402-guard (zero-dependency CLI and GitHub Action in packages/check-payee, Apache-2.0). No pressure. Either way, thanks for the open code.

---

## Notes for momo
- Do not paste the 24-word phrases or any keys anywhere. None of these messages needs them.
- The "second identity / friend company" asks (Global FinReg) are in docs/FRIENDS_BECOME_A_PAYEE.md, not here.
- The npm packages `payonce-check-payee` and `payonce-mcp` are **staged** (28 Nov) and go live when you approve them on npmjs.com (2FA). Until then the drafts point to the repo path, not `npx payonce-check-payee`. If you publish first, change the CLI lines.
- If a team replies and proves a name, re-run the check and quote the new verdict (Match) with the evidence hash.
