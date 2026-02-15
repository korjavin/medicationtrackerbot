#!/bin/sh
set -eu

REPO="korjavin/medicationtrackerbot"
BINARY="medtracker-installer"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux) ;;
  *) die "Unsupported OS: $OS (only Linux is supported)" ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
[ -n "$LATEST" ] || die "Could not determine latest release"

URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}_${OS}_${ARCH}.tar.gz"

printf 'Downloading MedTracker installer %s (%s/%s)...\n' "$LATEST" "$OS" "$ARCH"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" | tar xz -C "$TMP" || die "Download failed"

chmod +x "${TMP}/${BINARY}"
exec "${TMP}/${BINARY}" "$@"
