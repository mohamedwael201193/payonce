# EUDemo (PLT) rail with Verification of Payee: GO

**Verdict: GO.** PayOnce pays in **EUDemo** (Concordium's testnet euro PLT) as well as CCD. The payee check is the same on both rails. On the EUDemo rail the buyer agent paid **no fee** at any step (all fees sponsored).

The first full run was on 28 Nov 2026, 10:46–10:47 Cairo (08:46–08:47 UTC), on the v3 demo book `<13173,0>` (90 s cooling-off). The raw record is [`frontend/public/evidence/eudemo-vop-run-2026-11-28.json`](../frontend/public/evidence/eudemo-vop-run-2026-11-28.json), served at [/evidence/eudemo-vop-run-2026-11-28.json](https://payonce-tau.vercel.app/evidence/eudemo-vop-run-2026-11-28.json). Script: `api/scripts/eudemo-vop-run.mjs`.

| Step | Result | Tx |
|---|---|---|
| Buyer agent `3ARQvc…` approves seller `42jaZZ…` as a vendor (caps 1 EUDemo per payable, 5 per day), fee sponsored | success | [`a51b2c4f…`](https://ccdexplorer.io/testnet/transaction/a51b2c4f3bc4107e44a35949610032087db02884861338da7d6e44110b25e19f) |
| Seller registers payable 9000: **0.01 EUDemo** to its bound payee, payable only by the buyer agent | success | [`5499c54f…`](https://ccdexplorer.io/testnet/transaction/5499c54fba2189967c3ce283675775d89ae81e2a0bfc539b614694a306c49a33) |
| `check_payee` ("PayOnce Labs", labelled testnet stand-in) | **MATCH**, payable, evidence `16840c70…` | (read) |
| `reserve_plt`: the chain re-checks payee bound + matured + buyer acknowledgement, fee sponsored | success | [`894b1c76…`](https://ccdexplorer.io/testnet/transaction/894b1c7679f255cbf7ad6912320bbaf43c5280d5ae00cb7c1827905c274d2446) |
| Sponsor asked to co-sign the same transfer to **another account** | refused by the relayer (`wrong_recipient`); nothing sent | none |
| EUDemo transfer 0.01, memo `payable:42jaZZ…:9000`, fee sponsored | success (tokenUpdate) | [`7ddeb828…`](https://ccdexplorer.io/testnet/transaction/7ddeb8280c8e85dd42c2c691d1b308117d09cf0534cee7c02b18abb65a60eb8b) |
| `confirm_plt(tx hash)`, fee sponsored | **Paid**, the tx hash is recorded once | [`0219c2da…`](https://ccdexplorer.io/testnet/transaction/0219c2da836140fc9f0c870bb82d29bce434bee637f785883a03d31f8bbdd771) |
| Reserve it again | **refused by the chain**, reject -16 (not Unpaid) | [`5fac785d…`](https://ccdexplorer.io/testnet/transaction/5fac785d9174277ef182a427242c3fb6fc8fadfaa0e8d68799f075d48c012fbd) |

The transfer was read back from the node: token EUDemo, sender = buyer, recipient = bound payee, memo present, sponsored.

## What the chain does and does not do on this rail

- A contract cannot see or move a PLT. So the payee check, the one reservation and the replay refusal are enforced by `payable_registry_v3` (`reserve_plt` / `confirm_plt`). The transfer itself is a normal EUDemo `tokenUpdate`.
- Two things tie the transfer to the payable: the relayer co-signs only a transfer to that payable's bound payee, for that amount, while the payable is reserved by that sender; and `confirm_plt` stores the transfer hash once (a reused hash is refused, -12). If the buyer pays its own fee and skips the relayer, the receipt check still reads the transfer back from the node.
- EUDemo is allow-listed: the payer and the payee must both be on the token's allow list. PayOnce's three accounts are (module state `allowList: true`). An outside account needs Concordium to add it first.

## Dashboard

The `/app?dash=1` pay step offers **CCD** or **EUDemo**. On EUDemo the visitor's wallet signs the same four calls as this run: `reserve_plt` → sponsored EUDemo transfer (memo `payable:<seller>:<id>`, relayer co-signs only the bound payee and amount while Reserved) → `confirm_plt` → a re-reserve, which the chain refuses (−16). Concordium Wallet (browser) 2.10+ or CryptoX (Android). Both accounts must be on the EUDemo allow list.
