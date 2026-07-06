package cloudserver

import (
	"sync"
	"time"
)

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
