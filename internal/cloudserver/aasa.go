package cloudserver

import (
	"encoding/json"
	"net/http"
)

const aasaPath = "/.well-known/apple-app-site-association"

// SetAppleAppSiteAssociation enables the iOS app's Associated Domains
// confirmation file (webcredentials, so passkeys work in the WKWebView shell;
// bd med-w6gx.1). Empty team ID or bundle ID leaves it off and the path falls
// through to the normal routing. Served on the base domain and, without an
// account lookup, on every subdomain: Apple's CDN probes the host named in the
// entitlement, and the content is identical and public.
func (h *Handler) SetAppleAppSiteAssociation(teamID, bundleID string) {
	if teamID == "" || bundleID == "" {
		return
	}
	h.aasa, _ = json.Marshal(map[string]any{
		"webcredentials": map[string]any{"apps": []string{teamID + "." + bundleID}},
	})
}

// serveAASA writes the file and reports whether it handled the request.
func (h *Handler) serveAASA(w http.ResponseWriter, r *http.Request) bool {
	if h.aasa == nil || r.URL.Path != aasaPath || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(h.aasa)
	return true
}
