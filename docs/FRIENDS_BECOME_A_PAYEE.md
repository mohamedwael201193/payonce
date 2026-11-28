# Become a payee in 5 minutes (testnet)

You will get a Concordium **testnet** wallet, prove your name from it, and let an AI agent pay you only because the name matches.
Test money only. Nothing here costs real money. Arabic version: [FRIENDS_BECOME_A_PAYEE.ar.md](FRIENDS_BECOME_A_PAYEE.ar.md).

**What you need:** Chrome, Edge, Brave or Firefox on a computer, **or** an Android phone. About 5 minutes.
You need a recent wallet. Older ones cannot do the sponsored step:

| Wallet | Minimum version | Why |
|---|---|---|
| Concordium **Wallet for Web** (browser extension) | **2.10** (current is 2.12.2) | 2.10 added sponsored smart-contract updates; 2.8 only had plain sponsored transfers |
| Concordium Wallet for **Android** (formerly CryptoX), testnet build | **1.19** | 1.19 added sponsored smart-contract updates; 1.17 added identity proofs |
| iPhone | not supported yet for the sponsored step | its release notes (3.4.x) list no sponsored transactions |

Source: Concordium's release notes, docs.concordium.com/en/mainnet/technical-reference/release-notes.html.

## 1. Install the wallet and switch to testnet (1 min)
- **Computer:** install *Concordium Wallet for Web* from the link on docs.concordium.com (Chromium browsers). Create a wallet, **write down the 24 words**, then choose **Concordium Testnet**.
- **Android:** download the *Testnet* build from docs.concordium.com/en/mainnet/docs/installation/downloads.html (or the APKs at github.com/Concordium/cryptox-android). The APK is not signed like the Play Store one, so uninstall any older copy first.
- Set a passcode. Never share the 24 words, not even with us.

## 2. Create a testnet identity and account (1 min)
- Menu **Identities** → **+** → pick **Concordium testnet IP**. No ID documents are asked; the details are generated.
- Create an **account** from that identity. This is your payee account (an address starting with `3…` or `4…`).
- **Want to be paid as a company?** Request a second identity and pick **Global FinReg** (menu **Identities → +**). It is the company-identity provider and it is available on testnet. Concordium's exchange-onboarding page says testnet identities are issued without verification; the real-company flow (LEI, registry documents) is for mainnet. **If it asks for real documents, stop and use your personal identity.** Never upload real company papers to a test.
- Testnet names are **self-asserted mock identities**. That is fine for this test, and PayOnce says so on every screen.

## 3. Get test CCD (30 s)
- Open your account → **Activity** → **Request CCD**. About **20,000 test CCD** arrive in seconds. It works **once per account** and only if the account has had no incoming transfer yet, so do this **before** anything else.
- If the button is gone, the PayOnce page gives a small starter drop (150 CCD, limited per day). You need roughly 40 CCD to try the pay flow and 100 CCD for the seller flow, because testnet fees are high (about 21 CCD for a sponsored payment, about 5.6 for a refused retry).

## 4. Open PayOnce and prove your name (2 min)
- Go to **https://payonce-tau.vercel.app/app/sell** and press **Connect your wallet**.
  - Computer: choose the browser extension, approve.
  - Android: choose WalletConnect, scan the QR with the wallet (or tap the link on the phone), approve.
- Step **Prove the name on your invoices**: approve the request in the wallet. You reveal only your **first and last name** (or your **company legal name** with the Global FinReg identity), as a zero-knowledge proof. Nothing else is shared.
- Step **Register your seller agent**: one transaction from your account, then the card is published. Wait for the green tick.
- Your public card is `https://payonce-api-n98a.onrender.com/api/p/<your account>` (it shows your proven name, whether you are bound, and the hold). The friendly page `payonce-tau.vercel.app/p/<your account>` is being added.

## 5. Bind as the payee, then pay and be paid
- **Bind:** the payee-binding step asks you to sign once with your own wallet. PayOnce pays the network fee (you stay at 0 CCD spent). *Status 28 Nov: the sponsored bind API (`/api/relay/prepare`) is live; its button is being added to the page.* After binding there is a short **hold** (cooling-off), then the card shows **hold over**. An agent will only pay you after that.
- **Get paid:** register an invoice in the last steps of the page and press **Let the agent pay you**. The agent checks your name first. **Match** → it pays once. **Close match** or **verification not possible** → it stops and asks a person. **No match** → it pays nothing.
- **Pay someone:** open **https://payonce-tau.vercel.app/app** (**Run it**), choose **My own wallet**, and pay a friend's `/p/` link. A verdict appears before your wallet asks you to confirm.

## If something goes wrong
- *Request CCD missing:* the account already received funds. Use the PayOnce starter drop, or create a fresh account.
- *"Rejected by the node":* the account has too little CCD for the fee. Top up and retry once.
- *Wallet does not open the proof request on Android:* update to 1.19 or newer and reconnect.
- *Stuck:* send momo the screenshot and your account address. Never send the 24 words.

Honest limits: this is testnet. Names are mock identities. The chain checks your signature, the hold, the version and pay-once; it does **not** verify the zero-knowledge proof. A keyless verifier does, and anyone can re-run it.
