package mcp

import (
	"net/http"
	"strings"
)

// corsAllowedMethods are the HTTP methods the MCP transports accept from
// browser-origin callers.
const corsAllowedMethods = "GET, POST, OPTIONS"

// corsAllowedHeaders are the request headers allowed on cross-origin requests.
// Authorization carries the Bearer token, Content-Type is required for JSON-RPC
// bodies, and Mcp-Session-Id is used by the Streamable HTTP transport to
// resume a session across requests.
const corsAllowedHeaders = "Authorization, Content-Type, Mcp-Session-Id"

// corsMaxAge is the preflight cache lifetime in seconds.
const corsMaxAge = "600"

// CORSMiddleware wraps a handler with a simple Access-Control-Allow-Origin
// gate scoped to a single origin. When allowedOrigin is empty, the middleware
// is a no-op: it does not write any CORS headers and passes preflight requests
// straight to the next handler (which will typically return 405 or 404). This
// preserves the pre-CORS behavior for deployments that don't set APP_DOMAIN.
//
// The middleware sits in front of the OAuth middleware so OPTIONS preflights
// — which carry no Authorization header — short-circuit with 204 instead of
// being rejected as unauthenticated.
func CORSMiddleware(allowedOrigin string, next http.Handler) http.Handler {
	allowedOrigin = strings.TrimSpace(allowedOrigin)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if allowedOrigin == "" {
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		originAllowed := origin != "" && origin == allowedOrigin

		if originAllowed {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", allowedOrigin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", corsAllowedMethods)
			h.Set("Access-Control-Allow-Headers", corsAllowedHeaders)
			h.Set("Access-Control-Max-Age", corsMaxAge)
		}

		if r.Method == http.MethodOptions {
			if originAllowed {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			// Disallowed origin preflight: reject without leaking allow headers.
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}
