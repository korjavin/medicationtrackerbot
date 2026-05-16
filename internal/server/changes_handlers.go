package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

const (
	changeEventsKeepLast      = 20000
	changeEventsMaxAge        = 14 // days
	changeStreamPollInterval  = 5 * time.Second
	changeStreamQueryTimeout  = 2 * time.Second
	changeStreamMaxSessionAge = 10 * time.Minute
)

func (s *Server) currentChangeCursor() uint64 {
	cursor, err := s.changes.GetLatestChangeCursor(context.Background())
	if err != nil {
		return 0
	}
	if cursor < 0 {
		return 0
	}
	return uint64(cursor)
}

func (s *Server) maybePruneChangeEvents(cursor int64) {
	if cursor <= 0 || cursor%500 != 0 {
		return
	}
	if !s.changePruning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer s.changePruning.Store(false)
		if err := s.changes.PruneChangeEvents(context.Background(), changeEventsKeepLast, changeEventsMaxAge); err != nil {
			slog.Error("changes prune failed", "error", err)
		}
	}()
}

func (s *Server) tryAcquireChangeStreamSlot() bool {
	select {
	case s.changeStreamSem <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releaseChangeStreamSlot() {
	select {
	case <-s.changeStreamSem:
	default:
	}
}

// handleChanges returns changed resource tags since a client cursor.
func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	var since int64
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		if parsed, err := strconv.ParseInt(sinceStr, 10, 64); err == nil && parsed >= 0 {
			since = parsed
		}
	}

	cursor, changedTags, err := s.changes.ListChangedTagsSince(r.Context(), since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.maybePruneChangeEvents(cursor)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"cursor":       cursor,
		"changed_tags": changedTags,
	})
}

func writeSSE(w http.ResponseWriter, payload map[string]any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
		return err
	}
	return nil
}

// handleChangesStream provides server-sent events with cursor/tag updates.
func (s *Server) handleChangesStream(w http.ResponseWriter, r *http.Request) {
	if !s.tryAcquireChangeStreamSlot() {
		w.Header().Set("Retry-After", "10")
		http.Error(w, "Too many change-stream clients", http.StatusTooManyRequests)
		return
	}
	defer s.releaseChangeStreamSlot()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	var since int64
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		if parsed, err := strconv.ParseInt(sinceStr, 10, 64); err == nil && parsed >= 0 {
			since = parsed
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	// Note: Do NOT set "Connection: keep-alive" — it's a hop-by-hop header
	// forbidden in HTTP/2 and causes ERR_HTTP2_PROTOCOL_ERROR behind reverse proxies.
	_, _ = fmt.Fprint(w, "retry: 5000\n\n")
	flusher.Flush()

	queryCtx, cancel := context.WithTimeout(r.Context(), changeStreamQueryTimeout)
	cursor, tags, err := s.changes.ListChangedTagsSince(queryCtx, since)
	cancel()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.maybePruneChangeEvents(cursor)
	if err := writeSSE(w, map[string]any{
		"cursor":       cursor,
		"changed_tags": tags,
	}); err != nil {
		return
	}
	flusher.Flush()
	since = cursor

	ticker := time.NewTicker(changeStreamPollInterval)
	defer ticker.Stop()
	maxAgeTimer := time.NewTimer(changeStreamMaxSessionAge)
	defer maxAgeTimer.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-maxAgeTimer.C:
			return
		case <-ticker.C:
			queryCtx, cancel := context.WithTimeout(r.Context(), changeStreamQueryTimeout)
			cursor, tags, err := s.changes.ListChangedTagsSince(queryCtx, since)
			cancel()
			if err != nil {
				return
			}
			s.maybePruneChangeEvents(cursor)
			if len(tags) == 0 {
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
				continue
			}
			if err := writeSSE(w, map[string]any{
				"cursor":       cursor,
				"changed_tags": tags,
			}); err != nil {
				return
			}
			flusher.Flush()
			since = cursor
		}
	}
}
