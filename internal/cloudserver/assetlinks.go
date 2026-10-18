package cloudserver

import (
	"encoding/json"
	"net/http"
	"strings"
)

const assetLinksPath = "/.well-known/assetlinks.json"

// SetAndroidAssetLinks enables the Android app's Digital Asset Links file
// (get_login_creds so passkeys work in the WebView shell, handle_all_urls for
// app links; bd med-nt9p.2) — the Android twin of SetAppleAppSiteAssociation.
// certSHA256s is comma-separated colon-hex SHA-256 fingerprints. Empty package
// or no fingerprint leaves it off and the path falls through to the normal
// routing. Served on the base domain and, without an account lookup, on every
// subdomain: the RP ID is the per-account subdomain, and the content is
// identical and public.
func (h *Handler) SetAndroidAssetLinks(pkg, certSHA256s string) {
	fps := splitCertFingerprints(certSHA256s)
	if pkg == "" || len(fps) == 0 {
		return
	}
	h.assetLinks, _ = json.Marshal([]map[string]any{{
		"relation": []string{
			"delegate_permission/common.get_login_creds",
			"delegate_permission/common.handle_all_urls",
		},
		"target": map[string]any{
			"namespace":                "android_app",
			"package_name":             pkg,
			"sha256_cert_fingerprints": fps,
		},
	}})
}

// splitCertFingerprints splits ANDROID_CERT_SHA256S: comma-separated,
// trimmed, uppercased, blanks dropped. Shared with SetAndroidAppOrigins so the
// asset-links file and the WebAuthn app origins read the env the same way.
func splitCertFingerprints(certSHA256s string) []string {
	var fps []string
	for _, fp := range strings.Split(certSHA256s, ",") {
		if fp = strings.ToUpper(strings.TrimSpace(fp)); fp != "" {
			fps = append(fps, fp)
		}
	}
	return fps
}

// serveAssetLinks writes the file and reports whether it handled the request.
func (h *Handler) serveAssetLinks(w http.ResponseWriter, r *http.Request) bool {
	if h.assetLinks == nil || r.URL.Path != assetLinksPath || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(h.assetLinks)
	return true
}
