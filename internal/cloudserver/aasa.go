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
// entitlement, and the content is identical and public. applinks claims only
// the invite landing /i/* as a universal link (bd med-ta2n.9); the app's
// entitlement lists applinks for the base domain alone, so account subdomains
// never become universal links even though they serve the same file.
func (h *Handler) SetAppleAppSiteAssociation(teamID, bundleID string) {
	if teamID == "" || bundleID == "" {
		return
	}
	appID := teamID + "." + bundleID
	h.aasa, _ = json.Marshal(map[string]any{
		"applinks": map[string]any{"details": []any{map[string]any{
			"appIDs":     []string{appID},
			"components": []any{map[string]string{"/": "/i/*", "comment": "invite landing"}},
		}}},
		"webcredentials": map[string]any{"apps": []string{appID}},
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
