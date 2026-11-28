# Verifiable builds (Concordium)

A verifiable build lets anyone check that a deployed module was built from published source. The build
runs in Concordium's pinned image, the module carries the archive hash and a link to the source archive,
and CCDExplorer and ccdscan rebuild from that link to show "verified".

Official docs: <https://developer.concordium.software/en/mainnet/smart-contracts/guides/build-contract.html>
(see "Verifiable builds") and the `cargo-concordium` help for `build --verifiable`, `edit-build-info`, `verify-build`.

## One command

```bash
scripts/verifiable-build.sh contracts/<crate-dir>            # default link: raw GitHub URL on main
scripts/verifiable-build.sh contracts/<crate-dir> <url>      # custom link
```

Requirements: Docker, `cargo-concordium` 5.x, `Cargo.lock` committed, the `wasm32v1-none` target (the
script installs it). The crate gets a `.ignore` so build outputs stay out of the source archive.

Output in `contracts/<crate-dir>/verifiable/`:

- `<crate>.wasm.v1`: the versioned module with build info (image, command, archive hash, source link)
- `<crate>.wasm.v1.tar`: the exact source archive the hash covers

The script also verifies locally from the archive (`verify-build --source`), so a mismatch shows up
before anything is pushed.

## Steps to publish and deploy

1. Run the script. Note the module sha256 it prints.
2. Commit `verifiable/` and `.ignore`, then push to main so the source link resolves.
3. Check the public link: `cargo concordium edit-build-info --module <copy of m> --source-link <url> --verify` (checked for v2.1: passes)
4. Deploy the module on testnet (a separate, logged step; never from the script). The web SDK's
   `Transaction.deployModule` takes raw wasm: strip the 8-byte version prefix. `concordium-client module deploy`
   takes the versioned file as is. Then init the instance.
5. Open the module on CCDExplorer or ccdscan and confirm that it shows as verified.
6. Log the module ref, instance address and tx hashes in the private handoff.

`contracts/scripts/deploy-v21-verifiable.mjs` is a reference deployer (deploy plus init, refuses to run
twice, never resubmits a tx with unknown status). It was written for v2.1 and **has not been run**: v2.1 is
not being redeployed, and v3 replaces it. Copy it for v3 and change the crate name and init parameter.

## Reproducibility record: payable_registry_v2_1

| Item | Value |
| --- | --- |
| Image | `docker.io/concordium/verifiable-sc-wasm32v1:1` |
| Build command (in image) | `cargo +1.99.1 build --target wasm32v1-none --profile release --package payable_registry_v2_1 --target-dir /b/t --locked` |
| Archive sha256 | `6d6bca2d07dd4cb2acf5e29af6cc4ffd2b1f385da964f0e8883ac3121023eaf2` |
| Module sha256 (link embedded) | `ae5e47f0fa5a057c0e7bffc007c2361d16d4e05a81be217e087778ffb817a1d4` |
| Source link | `https://raw.githubusercontent.com/mohamedwael201193/payonce/main/contracts/payable_registry_v2_1/verifiable/payable_registry_v2_1.wasm.v1.tar` |
| Deployed | No. The live v2.1 instance `<13152,0>` runs the earlier non-verifiable build (`a299ab6b…`) |

The verifiable module differs from the deployed `a299ab6b…`: it was built in the pinned image and carries the
build-info section. A verified badge therefore needs a fresh deploy. That deploy is planned for v3, not for v2.1.

## Note for the box

The box's network blocks Concordium gRPC (`grpc.testnet.concordium.com:20000`), so deploys cannot run from the
box. Run them from a machine that can reach the node (for example momo's PC or a one-off job on the API host).

Reproducibility check, 28 Nov 2026: a second run of `scripts/verifiable-build.sh contracts/payable_registry_v2_1`
produced the same module sha256 (`ae5e47f0…`), `verify-build` printed "Source and module match", and
`edit-build-info --verify` against the public raw link passed.
