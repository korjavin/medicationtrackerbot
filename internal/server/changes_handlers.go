package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const (
	changeEventsKeepLast = 20000
	changeEventsMaxAge   = 14 // days
)

func (s *Server) currentChangeCursor() uint64 {
	cursor, err := s.store.GetLatestChangeCursor(context.Background())
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
	go func() {
		_ = s.store.PruneChangeEvents(context.Background(), changeEventsKeepLast, changeEventsMaxAge)
	}()
}

// handleChanges returns changed resource tags since a client cursor.
func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	var since int64
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		if parsed, err := strconv.ParseInt(sinceStr, 10, 64); err == nil && parsed >= 0 {
			since = parsed
		}
	}

	cursor, changedTags, err := s.store.GetChangedTagsSince(r.Context(), since)
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
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	cursor, tags, err := s.store.GetChangedTagsSince(r.Context(), since)
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

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			cursor, tags, err := s.store.GetChangedTagsSince(r.Context(), since)
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
