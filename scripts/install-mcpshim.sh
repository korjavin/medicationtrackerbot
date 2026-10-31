#!/bin/sh
# Public pinned installer: no code in download URLs, installer-owned temporary
# files, output or logs. Claude intentionally stores it in normal MCP config.
set -eu
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
version='' code='' replace=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) [ "$#" -ge 2 ] || fail 'Missing version.'; version=$2; shift 2 ;;
        --pairing-code) [ "$#" -ge 2 ] || fail 'Missing pairing code.'; code=$2; shift 2 ;;
        --replace-user-health) replace=true; shift ;;
        *) fail 'Usage: install.sh --version <version> --pairing-code <code> [--replace-user-health]' ;;
    esac
done
# Only stable decimal semver, with no path or shell metacharacters.
case "$version" in ''|*[!0-9.]*) fail 'An explicit stable version is required.' ;; esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail 'An explicit stable version is required.'
case "$code" in mtmcp1.?*) ;; *) fail 'A Med Tracker pairing code is required.' ;; esac
command -v claude >/dev/null 2>&1 || fail 'Install Claude Code first, then retry.'
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Supported systems: macOS, Linux, or WSL. Use install.ps1 on Windows.' ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) fail 'Unsupported CPU architecture.' ;; esac
if command -v sha256sum >/dev/null 2>&1; then
    digest() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
    digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail 'Install a SHA-256 tool (sha256sum or shasum) first.'; fi
if command -v curl >/dev/null 2>&1; then
    download() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$2" "$1" >/dev/null 2>&1; }
elif command -v wget >/dev/null 2>&1; then
    download() { wget --quiet --https-only --output-document="$2" "$1" >/dev/null 2>&1; }
else fail 'Install curl or wget first.'; fi
asset="mcpshim_${version}_${platform}_${arch}"
base="https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v${version}"
tmp=$(mktemp -d) || fail 'Cannot create private download directory.'
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail 'Cannot download the pinned checksum manifest.'
# Require exactly one syntactically valid entry for this exact filename.
expected=$(awk -v target="$asset" '
    $2 == target || $2 == "*" target { count++; if (NF == 2 && length($1) == 64 && $1 !~ /[^0-9a-fA-F]/) value=tolower($1); else bad=1 }
    END { if (count != 1 || bad || value == "") exit 1; print value }
' "$tmp/SHA256SUMS") || fail 'Missing, ambiguous, or invalid checksum entry.'
download "$base/$asset" "$tmp/mcpshim" || fail 'Cannot download the pinned helper.'
[ "$(digest "$tmp/mcpshim")" = "$expected" ] || fail 'Helper checksum mismatch; nothing was installed or registered.'
case "${XDG_DATA_HOME:-$HOME/.local/share}" in /*) data=${XDG_DATA_HOME:-$HOME/.local/share} ;; *) fail 'The user data directory must be absolute.' ;; esac
directory="$data/medtracker/mcpshim/$version"
binary="$directory/mcpshim"
# Refuse symlinks and unknown bytes, including at the destination directory.
mkdir -p "$directory" || fail 'Cannot create the versioned install directory.'
[ ! -L "$directory" ] && [ ! -L "$binary" ] || fail 'Refusing a symlink installation target.'
if [ -e "$binary" ]; then
    [ -f "$binary" ] && [ "$(digest "$binary")" = "$expected" ] || fail 'This version already contains different bytes; preserve it and choose another version.'
    [ -x "$binary" ] || fail 'The matching installed helper is not executable; restore its user execution permission before retrying.'
else
    # Stage on the destination filesystem; hard-link promotion is atomic and
    # refuses an existing target rather than overwriting a working process.
    stage=$(mktemp "$directory/.mcpshim.XXXXXXXX") || fail 'Cannot stage helper.'
    if ! cp "$tmp/mcpshim" "$stage" || ! chmod 700 "$stage" || ! ln "$stage" "$binary"; then
        rm -f "$stage"
        fail 'Cannot atomically install helper; existing versions were preserved.'
    fi
    rm -f "$stage"
fi
# Hash verification precedes execution. This key-free readiness check catches
# host execution refusal before an explicit replacement can remove anything.
probe_output=$(unset MEDTRACKER_MCP_CODE; "$binary" --version 2>/dev/null) || fail 'The verified helper could not run. Check host execution policy; nothing was registered.'
case "$probe_output" in "mcpshim $version+"*) source_commit=${probe_output#"mcpshim $version+"} ;; *) fail 'The verified helper did not report the requested release version; nothing was registered.' ;; esac
[ "${#source_commit}" -eq 40 ] || fail 'The verified helper did not report the requested release version; nothing was registered.'
case "$source_commit" in *[!0-9a-f]*) fail 'The verified helper did not report the requested release version; nothing was registered.' ;; esac
if [ "$replace" = true ]; then
    claude mcp remove --scope user health >/dev/null 2>&1 || fail 'Could not remove user-scope health. Other scopes were left unchanged.'
fi
if ! claude mcp add --env "MEDTRACKER_MCP_CODE=$code" --transport stdio --scope user health -- "$binary" >/dev/null 2>&1; then
    fail 'Claude registration failed. An existing user-scope health is preserved unless replacement was explicitly requested. To replace it, retry with --replace-user-health. Local/project entries are never removed.'
fi
printf '%s\n' 'Installed and registered user-scope health. Reconnect Claude; an unlocked paired browser must be online. Local/project health entries can shadow this registration.'
