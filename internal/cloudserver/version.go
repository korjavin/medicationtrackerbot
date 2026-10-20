package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"runtime/debug"
)

// devBuildID is what an un-stamped tree reports: `go run ./cmd/cloud` serves
// web/static/index.html with its literal TIMESTAMP_PLACEHOLDER still in place.
const devBuildID = "dev"

// assetFingerprint matches the `?v=<build_ts>` query string that CI stamps onto
// every asset URL in index.html (.github/workflows/deploy.yml → the
// TIMESTAMP_PLACEHOLDER sed; the Dockerfile does the same with a unix epoch for
// local image builds).
var assetFingerprint = regexp.MustCompile(`\?v=([^"'&]+)`)

// buildIDFrom lifts the build id back out of the served index.html rather than
// stamping the binary with -ldflags. The fingerprint is already there, already
// unique per deploy, and already means exactly "the assets changed" — which is
// the only question a client asking "am I stale?" cares about. A second,
// independently-injected build id could disagree with the one on the asset URLs;
// this one cannot.
func buildIDFrom(idx []byte) string {
	m := assetFingerprint.FindSubmatch(idx)
	if m == nil || string(m[1]) == "TIMESTAMP_PLACEHOLDER" {
		return devBuildID
	}
	return string(m[1])
}

// vcsRevision is the short git revision this binary was built from, "-dirty"
// when the tree was modified, or "" when the build carries no VCS info.
func vcsRevision() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	rev, dirty := "", ""
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "-dirty"
			}
		}
	}
	if rev == "" {
		return ""
	}
	if len(rev) > 7 {
		rev = rev[:7]
	}
	return rev + dirty
}

// stampDevVersion fills the Settings-footer VERSION_PLACEHOLDER on an unstamped
// build (go run, android-qa, plain docker build). deploy.yml's sed still wins in
// production: there the placeholder is already gone and buildID is not "dev".
// The label doubles as the build id so /api/version and the footer agree.
func stampDevVersion(idx []byte, buildID, rev string) ([]byte, string) {
	if buildID != devBuildID {
		return idx, buildID
	}
	if rev == "" {
		rev = devBuildID
	}
	return bytes.ReplaceAll(idx, []byte("VERSION_PLACEHOLDER"), []byte(rev)), rev
}

// serveVersion answers "is the build I booted with still the one you serve?".
// A running tab polls this without a reload and compares against the
// <meta name="medtracker-build-id"> it parsed at boot (injectCloudBoot).
// no-store so an intermediary can never answer it from a cache — the whole
// point of the endpoint is that it is fresher than the cached page asking it.
func (h *Handler) serveVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	json.NewEncoder(w).Encode(map[string]string{"build_id": h.buildID})
}
