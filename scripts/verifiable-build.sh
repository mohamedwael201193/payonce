#!/usr/bin/env bash
# verifiable-build.sh: reproducible (verifiable) build of a Concordium contract crate.
#
# Usage:  scripts/verifiable-build.sh <contract-dir> [source-link]
#   contract-dir  e.g. contracts/payable_registry_v2_1  (needs Cargo.toml + Cargo.lock)
#   source-link   URL where <crate>.wasm.v1.tar will be publicly reachable. Default: the raw
#                 GitHub URL on main for this repo. The link only has to resolve once the tar is pushed.
#
# What it does (official flow, cargo-concordium >= 4 and Docker):
#   1. cargo concordium build --verifiable --verifiable-image docker.io/concordium/verifiable-sc-wasm32v1:1
#      builds inside the pinned image and writes verifiable/<crate>.wasm.v1 plus the source
#      archive verifiable/<crate>.wasm.v1.tar (the archive hash goes into the module's build info)
#   2. cargo concordium edit-build-info --source-link <url>   embeds the link in the module
#   3. cargo concordium verify-build --source <tar>            rebuilds from the archive and
#      checks the module hash locally (no network needed)
#   4. prints sha256 of the module and the build info
# After the tar is pushed: `cargo concordium edit-build-info --module <m> --source-link <url> --verify`
# checks that the URL serves the same archive. Deploy the .wasm.v1 (strip the 8-byte version prefix
# for the raw-wasm deployModule API, or pass the versioned file to `concordium-client module deploy`).
# CCDExplorer and ccdscan then show the module as verified from the embedded link.
# Never deploy from this script. Deploying is a separate, logged step (see docs/VERIFIABLE_BUILD.md).
set -euo pipefail
IMAGE="docker.io/concordium/verifiable-sc-wasm32v1:1"
DIR="${1:?usage: scripts/verifiable-build.sh <contract-dir> [source-link]}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/$DIR"
CRATE="$(sed -n 's/^name *= *"\(.*\)"/\1/p' Cargo.toml | head -1)"
OUTDIR="verifiable"
MOD="$OUTDIR/$CRATE.wasm.v1"
LINK="${2:-https://raw.githubusercontent.com/mohamedwael201193/payonce/main/$DIR/$MOD.tar}"

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
cargo concordium --version >/dev/null || { echo "cargo-concordium is required (cargo install cargo-concordium)"; exit 1; }
[ -f Cargo.lock ] || { echo "Cargo.lock missing: verifiable builds run with --locked"; exit 1; }
rustup target list --installed | grep -q wasm32v1-none || rustup target add wasm32v1-none
if [ ! -f .ignore ]; then
  printf '# keep build artifacts out of the verifiable source archive\n*.wasm\n*.wasm.v1\n*.tar\n*.tar.gz\nverifiable/\ntarget/\n' > .ignore
  echo "wrote .ignore"
fi
mkdir -p "$OUTDIR"
echo "== 1/3 build in $IMAGE"
cargo concordium build --verifiable --verifiable-image "$IMAGE" --out "$MOD"
echo "== 2/3 embed source link: $LINK"
cargo concordium edit-build-info --module "$MOD" --source-link "$LINK"
echo "== 3/3 local verification from the archive"
cargo concordium verify-build --module "$MOD" --source "$MOD.tar"
echo
cargo concordium print-build-info --module "$MOD"
echo "module sha256: $(sha256sum "$MOD" | cut -d' ' -f1)"
echo "archive:       $MOD.tar"
echo "Next: commit $OUTDIR/ + .ignore, push, then:"
echo "  cargo concordium edit-build-info --module $MOD --source-link $LINK --verify"
