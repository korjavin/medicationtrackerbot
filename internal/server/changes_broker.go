package server

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// changeTailerInterval is the cadence at which the process-wide tailer polls
// change_events.MAX(id) to fan out broker notifications for writes that bypass
// notifyOnWriteMiddleware (Telegram bot callbacks, scheduler materialization,
// any in-process domain-service call). Lower values shrink Telegram-write
// latency at the cost of more idle SELECTs; 200ms is well below the "feels
// instant" threshold and adds ~5 indexed queries/second on an idle DB.
const changeTailerInterval = 200 * time.Millisecond

// ChangeBroker is a process-wide pub/sub for change-events cursor updates.
//
// It lets the SSE /api/changes/stream handler receive immediate wake-ups when
// any write happens (via notifyOnWriteMiddleware) instead of polling the
// change_events table every 5 seconds.
//
// Fan-out semantics: Notify is non-blocking — if a subscriber's buffered
// channel is full, the update is dropped. This is safe because the cursor is
// monotonic and each handler reconciles via ListChangedTagsSince(lastCursor)
// on every received wake, so a missed wake just means the next one carries
// the missed work too.
type ChangeBroker struct {
	mu     sync.RWMutex
	subs   map[chan int64]struct{}
	closed bool
}

// NewChangeBroker returns a ready-to-use broker.
func NewChangeBroker() *ChangeBroker {
	return &ChangeBroker{subs: make(map[chan int64]struct{})}
}

// Subscribe registers a new subscriber and returns its receive channel.
// The channel is buffered (size 1) so a single missed-while-busy notify is
// always retained. The subscription is automatically removed when ctx is
// cancelled. The returned channel is closed when CloseAll runs.
func (b *ChangeBroker) Subscribe(ctx context.Context) <-chan int64 {
	ch := make(chan int64, 1)
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		close(ch)
		return ch
	}
	b.subs[ch] = struct{}{}
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.Unsubscribe(ch)
	}()

	return ch
}

// Unsubscribe removes ch from the subscriber set and closes it.
// Safe to call multiple times — subsequent calls are no-ops.
func (b *ChangeBroker) Unsubscribe(ch chan int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.subs[ch]; !ok {
		return
	}
	delete(b.subs, ch)
	close(ch)
}

// Notify fans out cursor to every subscriber without blocking.
// A subscriber whose buffer is full silently drops this update.
func (b *ChangeBroker) Notify(cursor int64) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- cursor:
		default:
		}
	}
}

// CloseAll closes every subscriber channel and prevents new subscriptions.
// Used by graceful shutdown so in-flight stream handlers exit cleanly before
// the listener is torn down.
func (b *ChangeBroker) CloseAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for ch := range b.subs {
		delete(b.subs, ch)
		close(ch)
	}
}

// changeStatusRecorder is a tiny ResponseWriter wrapper that lets the
// notifyOnWriteMiddleware see the final response status without consuming
// the body. The status defaults to 200 because net/http auto-writes that
// status when a handler writes a body without calling WriteHeader explicitly.
type changeStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *changeStatusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *changeStatusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *changeStatusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.NewResponseController reach the underlying ResponseWriter
// for streaming-aware operations (e.g. clearing the write deadline on the SSE
// handler so that http.Server.WriteTimeout doesn't kill long-lived streams).
func (r *changeStatusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// notifyOnWriteMiddleware fans out a broker notification on every successful
// non-GET API response, so SSE subscribers wake up immediately instead of
// waiting for the next poll tick. The cursor is read from the ChangeStore
// after the handler returns, so the value is guaranteed to include the write
// that just happened (assuming the SQL triggers on change_events ran in the
// same handler's transaction).
//
// Notification is best-effort: lookup failures are logged and swallowed so
// they never affect the user-facing response. The cursor lookup uses a fresh
// short-deadline context (not r.Context()) so that a client disconnecting
// between the handler completing and the lookup running doesn't drop the
// notify — the write already succeeded server-side; other subscribers must
// still be woken.
func (s *Server) notifyOnWriteMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &changeStatusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)

		if s.changesBroker == nil || s.changes == nil {
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			return
		}
		if rec.status < 200 || rec.status >= 300 {
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		cursor, err := s.changes.GetLatestChangeCursor(ctx)
		if err != nil {
			slog.Debug("changes notify: cursor lookup failed", "error", err, "path", r.URL.Path)
			return
		}
		s.changesBroker.Notify(cursor)
	})
}

// Shutdown releases broker subscribers so in-flight SSE handlers can return
// cleanly before the HTTP listener is torn down. Safe to call multiple times.
// The ctx argument is accepted for future symmetry with http.Server.Shutdown;
// currently the broker close is synchronous and bounded.
func (s *Server) Shutdown(ctx context.Context) error {
	if s == nil || s.changesBroker == nil {
		return nil
	}
	s.changesBroker.CloseAll()
	return nil
}

// runChangeTailer polls change_events.MAX(id) on a fixed interval and fans
// out broker notifications whenever the cursor advances. It is the catch-all
// path for writes that don't traverse notifyOnWriteMiddleware: Telegram bot
// callbacks call domain services in-process, and the scheduler materializes
// intake rows on its own goroutine — neither flows through the HTTP wrapper,
// but every write that hits a watched table populates change_events via the
// SQL triggers in migration 027.
//
// The tailer never kills its own goroutine on cursor-read errors so a
// transient SQLite hiccup doesn't permanently silence the path; the next
// tick retries. The goroutine returns only when ctx is cancelled.
func (s *Server) runChangeTailer(ctx context.Context) {
	if s == nil || s.changes == nil || s.changesBroker == nil {
		return
	}

	// Seed lastCursor from a pre-loop read so the first tick doesn't fire a
	// spurious notify for rows that already existed at startup.
	initCtx, initCancel := context.WithTimeout(ctx, 2*time.Second)
	lastCursor, err := s.changes.GetLatestChangeCursor(initCtx)
	initCancel()
	if err != nil {
		slog.Warn("change tailer: initial cursor read failed", "error", err)
		lastCursor = 0
	}

	ticker := time.NewTicker(changeTailerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			qctx, qcancel := context.WithTimeout(ctx, 2*time.Second)
			cursor, err := s.changes.GetLatestChangeCursor(qctx)
			qcancel()
			if err != nil {
				slog.Warn("change tailer: cursor read failed", "error", err)
				continue
			}
			if cursor > lastCursor {
				s.changesBroker.Notify(cursor)
				lastCursor = cursor
			}
		}
	}
}
