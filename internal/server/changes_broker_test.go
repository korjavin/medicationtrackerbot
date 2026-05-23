package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestChangeBroker_SingleSubscriberReceivesNotify(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := b.Subscribe(ctx)
	b.Notify(42, "")

	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatalf("channel closed unexpectedly")
		}
		if ev.Cursor != 42 {
			t.Fatalf("got cursor %d, want 42", ev.Cursor)
		}
		if ev.SourceClientID != "" {
			t.Fatalf("got source %q, want empty", ev.SourceClientID)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("subscriber did not receive notify within 200ms")
	}
}

func TestChangeBroker_NotifyPropagatesSourceClientID(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := b.Subscribe(ctx)
	b.Notify(7, "client-abc")

	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatalf("channel closed unexpectedly")
		}
		if ev.Cursor != 7 {
			t.Fatalf("got cursor %d, want 7", ev.Cursor)
		}
		if ev.SourceClientID != "client-abc" {
			t.Fatalf("got source %q, want %q", ev.SourceClientID, "client-abc")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("subscriber did not receive notify within 200ms")
	}
}

func TestChangeBroker_MultiSubscriberFanOut(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 5
	chans := make([]<-chan ChangeEvent, n)
	for i := 0; i < n; i++ {
		chans[i] = b.Subscribe(ctx)
	}

	b.Notify(7, "writer-1")

	for i, ch := range chans {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("subscriber %d channel closed unexpectedly", i)
			}
			if ev.Cursor != 7 {
				t.Fatalf("subscriber %d got cursor %d, want 7", i, ev.Cursor)
			}
			if ev.SourceClientID != "writer-1" {
				t.Fatalf("subscriber %d got source %q, want %q", i, ev.SourceClientID, "writer-1")
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("subscriber %d did not receive notify within 200ms", i)
		}
	}
}

func TestChangeBroker_DropOnFullChannelDoesNotBlock(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Subscribe once but never drain — the size-1 buffer fills on the first
	// Notify and subsequent Notifies must drop instead of blocking.
	_ = b.Subscribe(ctx)

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			b.Notify(int64(i), "")
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("Notify blocked on full subscriber buffer")
	}
}

func TestChangeBroker_UnsubscribeRemovesFromSet(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	chRecv := b.Subscribe(ctx)
	// Recover the chan ChangeEvent (write-side) handle: there is no public
	// accessor, so we exercise the same code path that the ctx-cancel
	// goroutine uses.
	cancel()

	// After cancel, the goroutine should call Unsubscribe → channel closed.
	select {
	case _, ok := <-chRecv:
		if ok {
			// Channel may carry one in-flight value before close; drain and try again.
			select {
			case _, ok := <-chRecv:
				if ok {
					t.Fatalf("channel not closed after ctx cancel")
				}
			case <-time.After(200 * time.Millisecond):
				t.Fatalf("channel not closed after ctx cancel")
			}
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("channel not closed after ctx cancel")
	}

	// Notify after unsubscribe must not panic and must not deliver to the closed chan.
	b.Notify(99, "")
}

func TestChangeBroker_CtxCancelAutoUnsubscribes(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())

	ch := b.Subscribe(ctx)
	cancel()

	// Wait for the goroutine to call Unsubscribe and close the channel.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case _, ok := <-ch:
			if !ok {
				return // channel closed → unsubscribed
			}
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	t.Fatalf("channel not closed within 500ms of ctx cancel")
}

func TestChangeBroker_CloseAllClosesAllChannels(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 4
	chans := make([]<-chan ChangeEvent, n)
	for i := 0; i < n; i++ {
		chans[i] = b.Subscribe(ctx)
	}

	b.CloseAll()

	for i, ch := range chans {
		select {
		case _, ok := <-ch:
			if ok {
				t.Fatalf("subscriber %d channel not closed after CloseAll", i)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("subscriber %d not closed after CloseAll within 200ms", i)
		}
	}
}

func TestChangeBroker_SubscribeAfterCloseAllReturnsClosedChannel(t *testing.T) {
	b := NewChangeBroker()
	b.CloseAll()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := b.Subscribe(ctx)
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatalf("channel from post-CloseAll Subscribe should be closed")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("post-CloseAll Subscribe did not return a closed channel")
	}
}

func TestChangeBroker_CloseAllIsIdempotent(t *testing.T) {
	b := NewChangeBroker()
	b.CloseAll()
	// Must not panic on second call.
	b.CloseAll()
}

func TestChangeBroker_ConcurrentSubscribeNotify(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ch := b.Subscribe(ctx)
			// Receive at least one value, then return — broker must not deadlock.
			select {
			case <-ch:
			case <-time.After(500 * time.Millisecond):
			}
		}()
	}

	// Hammer Notify concurrently with the Subscribes.
	for i := 0; i < 100; i++ {
		go b.Notify(int64(i), "")
	}

	wg.Wait()
}

// TestChangeBroker_ConcurrentNotifyPreservesSourceAttribution checks that
// concurrent Notify calls with distinct SourceClientIDs deliver intact
// (Cursor, SourceClientID) pairs — the broker must not splice a cursor from
// one notify onto a source from another.
func TestChangeBroker_ConcurrentNotifyPreservesSourceAttribution(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Use a 100-buffered subscriber to avoid the drop-on-full path; we want
	// to inspect every event the broker did deliver.
	ch := make(chan ChangeEvent, 100)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	go func() {
		<-ctx.Done()
		b.Unsubscribe(ch)
	}()

	type pair struct {
		cursor int64
		source string
	}
	pairs := []pair{
		{1, "alpha"},
		{2, "beta"},
		{3, "gamma"},
		{4, "delta"},
		{5, "epsilon"},
	}
	expected := make(map[pair]bool, len(pairs))
	for _, p := range pairs {
		expected[p] = true
	}

	var wg sync.WaitGroup
	for _, p := range pairs {
		wg.Add(1)
		go func(p pair) {
			defer wg.Done()
			b.Notify(p.cursor, p.source)
		}(p)
	}
	wg.Wait()

	// Drain whatever the broker delivered.
	got := make(map[pair]bool)
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) && len(got) < len(pairs) {
		select {
		case ev := <-ch:
			got[pair{cursor: ev.Cursor, source: ev.SourceClientID}] = true
		case <-time.After(50 * time.Millisecond):
		}
	}

	if len(got) == 0 {
		t.Fatalf("no events delivered")
	}
	for p := range got {
		if !expected[p] {
			t.Fatalf("broker delivered spliced pair %+v that no Notify call produced", p)
		}
	}
}

// TestSanitizeClientID covers the bounds and rejection rules for inbound
// X-Client-ID values.
func TestSanitizeClientID(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"normal uuid", "11111111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-555555555555"},
		{"clamp at 64", strings.Repeat("a", 70), strings.Repeat("a", 64)},
		{"reject newline", "abc\ndef", ""},
		{"reject null byte", "abc\x00def", ""},
		{"reject DEL", "abc\x7fdef", ""},
		{"reject high byte", "abc\xc3\xa9", ""},
		{"printable ASCII allowed", "abc-DEF_123.!~", "abc-DEF_123.!~"},
		{"space allowed (printable)", "abc def", "abc def"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeClientID(tc.in); got != tc.want {
				t.Fatalf("sanitizeClientID(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNotifyOnWriteMiddleware_PropagatesClientIDHeader asserts that a write
// carrying X-Client-ID surfaces as ChangeEvent.SourceClientID on the broker.
func TestNotifyOnWriteMiddleware_PropagatesClientIDHeader(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()
	if srv.internalMux == nil {
		t.Fatal("Routes() did not populate internalMux")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	body := []byte(`{"measured_at":"2026-05-22T10:00:00Z","systolic":120,"diastolic":80,"pulse":70}`)
	req := httptest.NewRequest("POST", "/api/bp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-ID", "front-end-uuid-42")
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))
	w := httptest.NewRecorder()

	srv.internalMux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	select {
	case ev, ok := <-sub:
		if !ok {
			t.Fatal("subscription channel closed before fanout")
		}
		if ev.Cursor <= 0 {
			t.Errorf("Expected cursor > 0, got %d", ev.Cursor)
		}
		if ev.SourceClientID != "front-end-uuid-42" {
			t.Errorf("Expected SourceClientID = %q, got %q", "front-end-uuid-42", ev.SourceClientID)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("subscriber did not receive fanout within 200ms")
	}
}

// TestNotifyOnWriteMiddleware_NoHeaderPropagatesEmptySource asserts the
// broker still fires (with empty source) when X-Client-ID is omitted.
func TestNotifyOnWriteMiddleware_NoHeaderPropagatesEmptySource(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	body := []byte(`{"measured_at":"2026-05-22T10:00:00Z","systolic":121,"diastolic":81,"pulse":71}`)
	req := httptest.NewRequest("POST", "/api/bp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))
	w := httptest.NewRecorder()

	srv.internalMux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	select {
	case ev, ok := <-sub:
		if !ok {
			t.Fatal("subscription channel closed before fanout")
		}
		if ev.SourceClientID != "" {
			t.Errorf("Expected empty SourceClientID, got %q", ev.SourceClientID)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("subscriber did not receive fanout within 200ms")
	}
}

// TestNotifyOnWriteMiddleware_SanitisesHostileHeader asserts that a malformed
// X-Client-ID value (control chars, oversized) is replaced with empty string
// rather than propagated to subscribers.
func TestNotifyOnWriteMiddleware_SanitisesHostileHeader(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	body := []byte(`{"measured_at":"2026-05-22T10:00:00Z","systolic":122,"diastolic":82,"pulse":72}`)
	req := httptest.NewRequest("POST", "/api/bp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-ID", "ok\x00injected")
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))
	w := httptest.NewRecorder()

	srv.internalMux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	select {
	case ev, ok := <-sub:
		if !ok {
			t.Fatal("subscription channel closed before fanout")
		}
		if ev.SourceClientID != "" {
			t.Errorf("Expected sanitised SourceClientID to be empty, got %q", ev.SourceClientID)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("subscriber did not receive fanout within 200ms")
	}
}
