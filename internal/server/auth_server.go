//go:build !mobile

package server

import "net/http"

// tryMobileAuthOverride is the !mobile (server-build) sibling of the mobile
// hook in auth_mobile.go. On the server build there is no override — the
// cookie/demo path in handleAuthStatus runs as before, so this returns false
// without touching the response.
func tryMobileAuthOverride(_ http.ResponseWriter) bool {
	return false
}
