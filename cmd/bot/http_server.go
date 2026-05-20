package main

import (
	"net/http"
	"time"
)

// newHTTPServer returns the production HTTP server configuration shared by
// both server and mobile builds. Timeouts are tuned for: OpenFoodFacts search
// (slow, ~30s) on writes; chunked SSE streams; and a generous max header size
// for token-bearing OIDC redirects.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      45 * time.Second, // Increased to support 30s OpenFoodFacts search
		MaxHeaderBytes:    1 << 20,          // 1MB max header bytes
	}
}
