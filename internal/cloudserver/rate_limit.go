package cloudserver

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ceremonyRateLimitMax / ceremonyRateLimitWindow bound the unauthenticated (and
// re-auth) auth ceremonies per client IP. These are human-paced flows — a
// multi-device household adding several passkeys or a user retrying a login
// makes at most a handful of requests — so the ceiling is deliberately generous
// (30/min/IP): it slows credential-stuffing / claim-brute-force without ever
// tripping a legitimate person.
const (
	ceremonyRateLimitMax    = 30
	ceremonyRateLimitWindow = time.Minute
)

// clientIP returns the caller's IP for rate-limiting. cmd/cloud ALWAYS runs
// behind Traefik, which rewrites RemoteAddr to its own address and appends the
// real client to X-Forwarded-For. Keying on RemoteAddr alone would therefore
// put every user into ONE bucket (Traefik's address) and let a single client's
// ceremonies rate-limit everyone's login at once — an outage, not a protection
// (med-yor.15). So trust the last X-Forwarded-For hop (the address Traefik saw,
// which Traefik itself appends, so a client-supplied X-Forwarded-For header
// cannot spoof it), then X-Real-IP, then RemoteAddr for a direct connection.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// limitByIP wraps h so each client IP gets at most limiter.max hits per window.
// On reject it returns a bare 429 with no body detail — identical for every
// caller regardless of whether the account/credential/claim exists, so it adds
// no enumeration oracle to the deliberately-uniform auth error surface.
func limitByIP(limiter *rateLimiter, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow(clientIP(r)) {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// rateLimiter is a small sliding-window per-key rate limiter. Mirrors
// internal/mcp/rate_limit.go (itself mirroring internal/server/server.go);
// duplicated here rather than shared because cloudserver must not import
// bot-mode packages (see router.go's package doc + cloudstore/arch_test.go).
// Keep the implementations in sync if any of the three grows new behavior.
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
