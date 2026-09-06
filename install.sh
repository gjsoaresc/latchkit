#!/bin/sh
set -eu
version=latest; root="${XDG_DATA_HOME:-$HOME/.local/share}/latchkit"; artifact=; checksum=
while [ "$#" -gt 0 ]; do case "$1" in --version) version=$2; shift 2;; --root) root=$2; shift 2;; --artifact) artifact=$2; shift 2;; --checksum) checksum=$2; shift 2;; *) echo 'Usage: install.sh [--version VERSION] [--root PATH] [--artifact FILE_OR_URL] [--checksum FILE_OR_URL]' >&2; exit 2;; esac; done
case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Unsupported operating system.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) architecture=x64;; arm64|aarch64) architecture=arm64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
target="$platform-$architecture"
case "$target" in linux-x64|darwin-x64|darwin-arm64) ;; *) echo "Unsupported target: $target" >&2; exit 1;; esac
if [ "$platform" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo 'Unsupported Linux libc; glibc is required.' >&2; exit 1; fi
if [ -z "$artifact" ] && [ "$version" = latest ]; then release=$(curl --fail --location --silent --show-error https://api.github.com/repos/willahealm/latchkit/releases/latest); version=$(printf '%s' "$release" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1); [ -n "$version" ] || { echo 'Could not resolve latest release.' >&2; exit 1; }; fi
version=${version#v}
[ -n "$artifact" ] || artifact="https://github.com/willahealm/latchkit/releases/download/v$version/latchkit-$version-$target.tar.gz"
[ -n "$checksum" ] || checksum="$artifact.sha256"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/latchkit-install.XXXXXX"); trap 'rm -rf "$temporary"' EXIT HUP INT TERM
fetch() { if [ -f "$1" ]; then cp "$1" "$2"; else curl --fail --location --silent --show-error "$1" -o "$2"; fi; }
fetch "$artifact" "$temporary/archive.tar.gz"; fetch "$checksum" "$temporary/checksum"
expected=$(awk '{print $1; exit}' "$temporary/checksum"); actual=$( (sha256sum "$temporary/archive.tar.gz" 2>/dev/null || shasum -a 256 "$temporary/archive.tar.gz") | awk '{print $1}')
[ "$expected" = "$actual" ] && [ "${#expected}" -eq 64 ] || { echo 'Archive SHA-256 verification failed.' >&2; exit 1; }
mkdir "$temporary/bundle"; tar -xzf "$temporary/archive.tar.gz" -C "$temporary/bundle"
node="$temporary/bundle/runtime/node"; entry="$temporary/bundle/app/dist/src/installation/entry.js"; [ -f "$node" ] && [ -f "$entry" ] || { echo 'Archive has an unsupported bundle layout.' >&2; exit 1; }
set -- "$entry" install --root "$root" --bundle "$temporary/bundle" --target "$target"
if [ "$version" != latest ]; then set -- "$@" --version "$version"; fi
set +e; "$node" "$@"; status=$?; set -e
if [ "$status" -eq 0 ]; then printf 'Use %s/bin/latchkit or add its bin directory to PATH.\n' "$root"; fi
exit "$status"
