#!/bin/sh
# Install issue-attack: download the latest release binary for this platform,
# verify its checksum, and install it (as `ia` and `issue-attack`) to
# INSTALL_DIR (default ~/.local/bin).
#
#   curl -fsSL https://raw.githubusercontent.com/robtandy/issue_attack/main/scripts/install.sh | sh
#
# Override the destination with INSTALL_DIR, e.g.:
#   INSTALL_DIR=/usr/local/bin sh scripts/install.sh
set -eu

REPO="robtandy/issue_attack"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required but not installed"

# ---- platform -> release asset ------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Darwin:arm64) asset=ia-darwin-arm64 ;;
  Darwin:x86_64) asset=ia-darwin-x64 ;;
  Linux:x86_64) asset=ia-linux-x64 ;;
  Linux:aarch64) asset=ia-linux-arm64 ;;
  *) die "no binary for $os $arch — install via npm instead: npm install -g issue-attack" ;;
esac

base="https://github.com/$REPO/releases/latest/download"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "downloading $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"

say "verifying checksum"
if command -v shasum >/dev/null 2>&1; then
  (cd "$tmp" && shasum -a 256 -c "$asset.sha256" >/dev/null) || die "checksum verification failed"
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c "$asset.sha256" >/dev/null) || die "checksum verification failed"
else
  die "neither shasum nor sha256sum found — cannot verify checksum"
fi

mkdir -p "$INSTALL_DIR"
cp "$tmp/$asset" "$INSTALL_DIR/ia"
chmod +x "$INSTALL_DIR/ia"
ln -sf ia "$INSTALL_DIR/issue-attack"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "note: $INSTALL_DIR is not on PATH; add it to your shell profile to run ia" ;;
esac

say "installed to $INSTALL_DIR (ia, issue-attack)"
"$INSTALL_DIR/ia" --version
