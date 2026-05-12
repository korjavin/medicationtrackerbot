package bot

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPendingPhotoStore_PutTakeRoundTrip(t *testing.T) {
	store := newPendingPhotoStore()
	exif := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	token, err := store.put(pendingPhotoEntry{
		chatID:     42,
		imageBytes: []byte("jpegbytes"),
		mimeType:   "image/jpeg",
		exifTime:   exif,
	})
	if err != nil {
		t.Fatalf("put returned error: %v", err)
	}
	if len(token) != 32 {
		t.Fatalf("expected 32-char hex token, got %q (len=%d)", token, len(token))
	}

	got, ok := store.take(token)
	if !ok {
		t.Fatal("expected take to return the entry, got ok=false")
	}
	if got.chatID != 42 {
		t.Errorf("chatID: want 42, got %d", got.chatID)
	}
	if string(got.imageBytes) != "jpegbytes" {
		t.Errorf("imageBytes: want %q, got %q", "jpegbytes", got.imageBytes)
	}
	if got.mimeType != "image/jpeg" {
		t.Errorf("mimeType: want image/jpeg, got %s", got.mimeType)
	}
	if !got.exifTime.Equal(exif) {
		t.Errorf("exifTime: want %v, got %v", exif, got.exifTime)
	}

	if _, ok := store.take(token); ok {
		t.Error("expected second take to return ok=false (one-shot semantics)")
	}
}

func TestPendingPhotoStore_TakeUnknownToken(t *testing.T) {
	store := newPendingPhotoStore()
	if _, ok := store.take("nope"); ok {
		t.Error("expected take of unknown token to return ok=false")
	}
}

func TestPendingPhotoStore_DefaultTTLSetOnPut(t *testing.T) {
	store := newPendingPhotoStore()
	fixed := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return fixed }

	token, err := store.put(pendingPhotoEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	store.mu.Lock()
	got := store.entries[token]
	store.mu.Unlock()

	wantExpiry := fixed.Add(pendingPhotoTTL)
	if !got.expiresAt.Equal(wantExpiry) {
		t.Errorf("expiresAt: want %v, got %v", wantExpiry, got.expiresAt)
	}
}

func TestPendingPhotoStore_ExpiredEntryNotReturned(t *testing.T) {
	store := newPendingPhotoStore()
	current := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return current }

	token, err := store.put(pendingPhotoEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	current = current.Add(pendingPhotoTTL + time.Second)

	if _, ok := store.take(token); ok {
		t.Error("expected take of expired token to return ok=false")
	}

	store.mu.Lock()
	_, stillPresent := store.entries[token]
	store.mu.Unlock()
	if stillPresent {
		t.Error("expected expired entry to be evicted by take")
	}
}

func TestPendingPhotoStore_GCExpiredRemovesOnlyExpired(t *testing.T) {
	store := newPendingPhotoStore()
	base := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return base }

	freshToken, err := store.put(pendingPhotoEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put fresh: %v", err)
	}

	staleToken := "stale"
	store.mu.Lock()
	store.entries[staleToken] = pendingPhotoEntry{
		chatID:    2,
		expiresAt: base.Add(-time.Minute),
	}
	store.mu.Unlock()

	store.gcExpired(base)

	store.mu.Lock()
	_, hasFresh := store.entries[freshToken]
	_, hasStale := store.entries[staleToken]
	store.mu.Unlock()

	if !hasFresh {
		t.Error("fresh entry should not have been gc'd")
	}
	if hasStale {
		t.Error("stale entry should have been gc'd")
	}
}

func TestPendingPhotoStore_ConcurrentPutTakeRaceSafe(t *testing.T) {
	store := newPendingPhotoStore()

	const writers = 8
	const perWriter = 50
	tokens := make(chan string, writers*perWriter)
	var wg sync.WaitGroup

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				tok, err := store.put(pendingPhotoEntry{
					chatID:     int64(i),
					imageBytes: []byte("x"),
					mimeType:   "image/jpeg",
				})
				if err != nil {
					t.Errorf("put: %v", err)
					return
				}
				tokens <- tok
			}
		}()
	}

	var taken int64
	var takers sync.WaitGroup
	for r := 0; r < writers; r++ {
		takers.Add(1)
		go func() {
			defer takers.Done()
			for tok := range tokens {
				if _, ok := store.take(tok); ok {
					atomic.AddInt64(&taken, 1)
				}
			}
		}()
	}

	wg.Wait()
	close(tokens)
	takers.Wait()

	if got, want := atomic.LoadInt64(&taken), int64(writers*perWriter); got != want {
		t.Errorf("taken count: want %d, got %d", want, got)
	}
}
