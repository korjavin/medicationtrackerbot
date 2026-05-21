package mcp

import (
	"strings"
	"sync"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
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
	rl := &rateLimiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
	}
	rl.startCleanup()
	return rl
}

// startCleanup runs a background goroutine that periodically evicts expired
// IP buckets from r.hits. Without this the map grows unbounded on a
// public-facing demo: every distinct IP that ever called mcp_execute adds a
// permanent entry. Mirrors the server-side rateLimiter.startCleanup.
func (r *rateLimiter) startCleanup() {
	ticker := time.NewTicker(r.window)
	go func() {
		for range ticker.C {
			r.cleanup()
		}
	}()
}

func (r *rateLimiter) cleanup() {
	now := time.Now()
	cutoff := now.Add(-r.window)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, hits := range r.hits {
		if len(hits) == 0 {
			delete(r.hits, key)
			continue
		}
		if hits[len(hits)-1].Before(cutoff) {
			delete(r.hits, key)
		}
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

// clientIPFromExtra returns the client IP from a tool-call request's per-POST
// headers. The MCP SDK's streamable HTTP transport attaches the original
// request headers to jreq.Extra at dispatch time (streamable.go's servePOST
// stamps them on every POST), so this is the only reliable per-POST IP signal
// available inside a tool handler — the ctx passed to the handler is the
// connection-level ctx captured at session-init time and is identical across
// every POST in the session, so a context-injection middleware would
// attribute every call in a session to the IP that initiated the session.
//
// The legacy SSE transport (clients like ElevenLabs) never sets jreq.Extra,
// so extra is nil for SSE callers and they all share the empty-string bucket.
// Operators relying on per-IP attribution must steer clients to the
// streamable HTTP /mcp endpoint.
//
// When trustProxy is true, X-Forwarded-For (first hop) and X-Real-IP are
// honored. When trustProxy is false there is no RemoteAddr in Extra; the
// function returns "" and the limiter falls back to a single shared bucket
// for all callers. The demo runbook documents AUTH_TRUST_PROXY=1 as required
// for this reason.
func clientIPFromExtra(extra *sdkmcp.RequestExtra, trustProxy bool) string {
	if extra == nil || extra.Header == nil || !trustProxy {
		return ""
	}
	if xff := extra.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	if xrip := extra.Header.Get("X-Real-IP"); xrip != "" {
		return xrip
	}
	return ""
}
