package cloudserver

import (
	"encoding/json"
	"net/http"
	"regexp"
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

// serveVersion answers "is the build I booted with still the one you serve?".
// A running tab polls this without a reload and compares against the
// <meta name="medtracker-build-id"> it parsed at boot (injectCloudBoot).
// no-store so an intermediary can never answer it from a cache — the whole
// point of the endpoint is that it is fresher than the cached page asking it.
//
// local_only_poc is the operator kill-switch for the med-eas.2.1 POC: the
// client's opt-in flag alone does nothing unless the server advertises true
// here (and register/finish enforces the same switch), so a crafted
// ?local-only-poc=1 link can never push a user into the fallback on an
// operator that never enabled it.
func (h *Handler) serveVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	json.NewEncoder(w).Encode(map[string]any{"build_id": h.buildID, "local_only_poc": h.localOnlyPOC})
}
