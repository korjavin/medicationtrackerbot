#!/bin/sh
# Local mode (bd med-o7zq.4): copy the web app into ios/LocalApp/, which the
# app bundle carries as a folder and ios/App/LocalApp.swift serves on
# wgapp://local/. Run by .github/workflows/ios.yml before `xcodegen generate`,
# so web/static, web/cloud and web/domain come from the one checked-out revision.
#
# Layout mirrors cmd/cloud's account-host routing (internal/cloudserver/router.go
# ServeHTTP): "/" → index.html, /static/* → static/, /domain/* → domain/,
# anything else (/js/*, /css/*, /vendor/*) → cloud/.
#
# Usage: ios/bundle-web.sh <build-id>
#        QA=1 ios/bundle-web.sh <build-id>   # + the visual QA driver (bd med-y5xx.1)
# android.yml reuses it (bd med-nt9p.32.2) with two overrides, both unset on iOS:
#        WG_BUNDLE_OUT=<repo-relative dir>   # default ios/LocalApp
#        WG_BUNDLE_PREFIX=<build-id prefix>  # default ios → "ios-<build-id>"
set -eu
build="${WG_BUNDLE_PREFIX:-ios}-${1:?build id}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
rel="${WG_BUNDLE_OUT:-ios/LocalApp}"
case "$rel" in /*|*..*|'') echo "WG_BUNDLE_OUT must be a repo-relative dir" >&2; exit 1;; esac
out="$repo/$rel"

rm -rf "$out"
mkdir -p "$out"
cp -R "$repo/web/static" "$out/static"
cp -R "$repo/web/cloud" "$out/cloud"
cp -R "$repo/web/domain" "$out/domain"
# Test suites and Go embed glue are not part of the served app.
rm -rf "$out/static/js/tests" "$out/cloud/js/tests"
find "$out" -name '*.go' -delete

# The local document: web/static/index.html with the fingerprints filled in
# (as deploy.yml does for cloud) and, right after <head>, only what the local
# entry needs of injectCloudBoot (router.go): the build-id meta and the boot
# script. No food-DB URL, no trial flags (no operator in local mode), no
# update-check.js (there is no /api/version to ask). The entry is a classic
# script like cloud-boot.js: it must run before every web/static script.
sed -e "s|TIMESTAMP_PLACEHOLDER|$build|g" \
    -e "s|VERSION_PLACEHOLDER|$build|g" \
    -e "s|<head>|<head><meta name=\"medtracker-build-id\" content=\"$build\"><script src=\"/js/local-boot.js\"></script>|" \
    "$repo/web/static/index.html" > "$out/index.html"
grep -q 'src="/js/local-boot.js"' "$out/index.html"
if grep -q PLACEHOLDER "$out/index.html"; then echo "unfilled placeholder in index.html" >&2; exit 1; fi

# QA=1 (the ios.yml visual job only, docs/design/ios-visual-testing.md): the
# scene driver, its scene list and the golden vault, served at /qa/* (which
# LocalOrigin.file(for:) maps to cloud/qa/) and loaded right after the local
# entry, before every web/static script: the driver pins the page clock at
# document start (bd med-y5xx.8), then waits for the app's boot itself.
# Without QA=1 none of it is in the bundle and /qa/* is a 404.
if [ "${QA:-}" = 1 ]; then
    mkdir -p "$out/cloud/qa"
    cp "$repo/tests/visual/driver.js" "$repo/tests/visual/driver.css" "$repo/tests/visual/scenes.json" "$out/cloud/qa/"
    cp "$repo/tests/fixtures/vault-v1.json" "$out/cloud/qa/vault-v1.json"
    sed -e 's|<script src="/js/local-boot.js"></script>|&<link rel="stylesheet" href="/qa/driver.css"><script src="/qa/driver.js"></script>|' \
        "$out/index.html" > "$out/index.qa.html"
    mv "$out/index.qa.html" "$out/index.html"
    grep -q 'src="/qa/driver.js"' "$out/index.html"
    echo "QA=1: bundled the visual QA driver"
elif [ -e "$out/cloud/qa" ] || grep -q '/qa/' "$out/index.html"; then
    echo "QA code in a non-QA bundle" >&2; exit 1
fi
echo "bundled web app into $rel ($build)"
