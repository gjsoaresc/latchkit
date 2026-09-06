#!/bin/sh
set -eu
repo=$1
cd "$repo"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
set -- "$repo"/release-artifacts/latchkit-*-linux-x64.tar.gz
[ "$#" -eq 1 ] && [ -f "$1" ] || { printf '%s\n' 'Exactly one Linux bundle is required.' >&2; exit 1; }
(cd "$repo/release-artifacts" && sha256sum -c "$(basename "$1").sha256")
tar -xzf "$1" -C "$scratch"
"$scratch/runtime/node" "$repo/dist/scripts/bundle-smoke.js" --directory "$repo/release-artifacts" --require-wsl --mounted-project "$repo/.latchkit/wsl-native-smoke"
