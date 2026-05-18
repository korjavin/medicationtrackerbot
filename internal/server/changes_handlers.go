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
	changeEventsKeepLast          = 20000
	changeEventsMaxAge            = 14 // days
	changeStreamKeepaliveInterval = 15 * time.Second
	changeStreamQueryTimeout      = 2 * time.Second
	changeStreamMaxSessionAge     = 10 * time.Minute
	// changeStreamCursorCheckInterval is a defense-in-depth ticker on each open
	// SSE stream. The primary mechanism for catching writes that bypass
	// notifyOnWriteMiddleware (Telegram bot callbacks, scheduler intake
	// materialization) is now the process-wide tailer goroutine started in
	// Server.New, which polls change_events every ~200ms and fans out via the
	// broker. This per-stream backstop only kicks in if the tailer ever stalls
	// (goroutine deadlock or runtime issue), so 5 minutes is plenty — the cost
	// is one indexed SELECT per stream per 5 min.
	changeStreamCursorCheckInterval = 5 * time.Minute
)

func (s *Server) currentChangeCursor() uint64 {
	ctx, cancel := context.WithTimeout(context.Background(), changeStreamQueryTimeout)
	defer cancel()
	cursor, err := s.changes.GetLatestChangeCursor(ctx)
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
//
// Wake-ups come from the process-wide ChangeBroker (notified by
// notifyOnWriteMiddleware on every successful write). A 15s keepalive comment
// is emitted between events to keep idle connections from being closed by
// reverse proxies. A 10-minute forced recycle bounds session lifetime so
// long-lived connections rotate through Traefik's keepalive accounting.
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

	// Clear the per-connection write deadline that http.Server.WriteTimeout
	// would otherwise impose (~45s in production). SSE sessions are bounded
	// by changeStreamMaxSessionAge (10 min) instead, and reverse proxies are
	// kept alive via the 15s keepalive comment.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	var since int64
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		if parsed, err := strconv.ParseInt(sinceStr, 10, 64); err == nil && parsed >= 0 {
			since = parsed
		}
	}

	// Subscribe BEFORE the initial state read so a write that happens between
	// the read and entering the select loop still wakes us up.
	subCtx, cancelSub := context.WithCancel(r.Context())
	defer cancelSub()
	sub := s.changesBroker.Subscribe(subCtx)

	queryCtx, cancel := context.WithTimeout(r.Context(), changeStreamQueryTimeout)
	cursor, tags, err := s.changes.ListChangedTagsSince(queryCtx, since)
	cancel()
	if err != nil {
		// The response is still in "headers not yet sent" state — a real HTTP
		// error response is safe here.
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	// Note: Do NOT set "Connection: keep-alive" — it's a hop-by-hop header
	// forbidden in HTTP/2 and causes ERR_HTTP2_PROTOCOL_ERROR behind reverse proxies.
	_, _ = fmt.Fprint(w, "retry: 5000\n\n")
	flusher.Flush()

	s.maybePruneChangeEvents(cursor)
	if err := writeSSE(w, map[string]any{
		"cursor":       cursor,
		"changed_tags": tags,
	}); err != nil {
		return
	}
	flusher.Flush()
	since = cursor

	keepalive := time.NewTicker(changeStreamKeepaliveInterval)
	defer keepalive.Stop()
	maxAgeTimer := time.NewTimer(changeStreamMaxSessionAge)
	defer maxAgeTimer.Stop()
	// Defense-in-depth ticker in case the process-wide change tailer ever
	// stalls. The tailer (Server.runChangeTailer) is the primary catch for
	// writes that bypass notifyOnWriteMiddleware (Telegram bot callbacks,
	// scheduler materialization) and fires on a 200ms cadence; this 5-minute
	// per-stream check is just a single indexed integer SELECT as insurance.
	cursorCheck := time.NewTicker(changeStreamCursorCheckInterval)
	defer cursorCheck.Stop()

	emit := func() bool {
		qCtx, qCancel := context.WithTimeout(r.Context(), changeStreamQueryTimeout)
		cursor, tags, err := s.changes.ListChangedTagsSince(qCtx, since)
		qCancel()
		if err != nil {
			return false
		}
		s.maybePruneChangeEvents(cursor)
		// Always advance `since` to the latest observed cursor, even when no
		// tags are returned, so a subsequent spurious wake doesn't re-scan
		// the same empty range.
		since = cursor
		if len(tags) == 0 {
			return true
		}
		if err := writeSSE(w, map[string]any{
			"cursor":       cursor,
			"changed_tags": tags,
		}); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-maxAgeTimer.C:
			return
		case _, ok := <-sub:
			if !ok {
				// Broker closed (graceful shutdown). Exit cleanly so the
				// client sees onerror and reconnects after restart.
				return
			}
			if !emit() {
				return
			}
		case <-cursorCheck.C:
			if !emit() {
				return
			}
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
