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
// the invite landing /i/* as a universal link (bd med-ta2n.9). The file is
// served on every subdomain too, so the app's entitlement (ios/project.yml,
// added by med-ta2n.11) MUST list applinks for the base domain only — never
// "applinks:*.<base>" — or account subdomains' /i/* become universal links.
// handoff (HANDOFF_APP_LINKS, bd med-r1j2.7) also claims the add-device
// hand-off /d/*: only once the shipped app takes /d/ links, because an older
// app opened by one drops it and the camera never reaches the browser landing.
func (h *Handler) SetAppleAppSiteAssociation(teamID, bundleID string, handoff bool) {
	if teamID == "" || bundleID == "" {
		return
	}
	appID := teamID + "." + bundleID
	components := []any{map[string]string{"/": "/i/*", "comment": "invite landing"}}
	if handoff {
		components = append(components, map[string]string{"/": "/d/*", "comment": "add-device hand-off"})
	}
	h.aasa, _ = json.Marshal(map[string]any{
		"applinks": map[string]any{"details": []any{map[string]any{
			"appIDs":     []string{appID},
			"components": components,
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
