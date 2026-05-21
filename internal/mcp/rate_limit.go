package mcp

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// rateLimiter is a small sliding-window per-key rate limiter. Mirrors the
// helper in internal/server/server.go; duplicated here because the MCP binary
// must not import the server package (separate process, separate package
// surface). Keep the implementations in sync if either grows new behavior.
type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
	}
}

// Allow returns true if the caller identified by key has fewer than max hits
// in the trailing window. It records the hit on success.
func (r *rateLimiter) Allow(key string) bool {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	hits := r.hits[key]
	cutoff := now.Add(-r.window)
	pruned := hits[:0]
	for _, t := range hits {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	if len(pruned) >= r.max {
		r.hits[key] = pruned
		return false
	}
	pruned = append(pruned, now)
	r.hits[key] = pruned
	return true
}

// clientIP returns the best-guess client IP. When trustProxy is true the
// X-Forwarded-For / X-Real-IP headers are honored (the demo deploy sits
// behind Traefik). Otherwise the raw RemoteAddr host is used.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				return strings.TrimSpace(parts[0])
			}
		}
		if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
			return xrip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// mcpClientIPKeyType is the unexported context-key type for the per-request
// client IP. Using a typed empty struct avoids collisions with other context
// keys (the standard linter rule against string keys).
type mcpClientIPKeyType struct{}

var mcpClientIPKey mcpClientIPKeyType

func withClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, mcpClientIPKey, ip)
}

// clientIPFromCtx returns the client IP previously injected by
// clientIPMiddleware, or "" when no middleware ran (e.g. unit tests bypassing
// buildPublicMux).
func clientIPFromCtx(ctx context.Context) string {
	if v, ok := ctx.Value(mcpClientIPKey).(string); ok {
		return v
	}
	return ""
}

// clientIPMiddleware extracts the client IP from the request (honoring XFF
// when trustProxy is true) and injects it into the request context so MCP
// tool handlers reached through the SDK can look it up via clientIPFromCtx.
// The MCP SDK owns the tool dispatch, so per-IP rate limiting cannot live in
// the HTTP middleware itself — this seam is the bridge.
func clientIPMiddleware(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r, trustProxy)
			next.ServeHTTP(w, r.WithContext(withClientIP(r.Context(), ip)))
		})
	}
}
