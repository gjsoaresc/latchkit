#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$root/.baml-version")
[ "$version" = '0.17.0' ] || { printf '%s\n' 'Review the CLI/runtime pair before changing the BAML pin.' >&2; exit 1; }
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT HUP INT TERM
curl -fsSL https://pkg.boundaryml.com/install.sh -o "$installer"
sh "$installer" --version "$version" --yes
export BAML_VERSION="$version"
cd "$root"
"$HOME/.baml/bin/baml" agent install
"$HOME/.baml/bin/baml" run main
