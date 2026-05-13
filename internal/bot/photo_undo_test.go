package bot

import (
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUndoBatchStore_PutTakeRoundTrip(t *testing.T) {
	store := newUndoBatchStore()
	ids := []int64{11, 12, 13}
	token, err := store.put(undoBatchEntry{
		chatID:     42,
		messageID:  7,
		foodLogIDs: ids,
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
	if got.messageID != 7 {
		t.Errorf("messageID: want 7, got %d", got.messageID)
	}
	if !reflect.DeepEqual(got.foodLogIDs, ids) {
		t.Errorf("foodLogIDs: want %v, got %v", ids, got.foodLogIDs)
	}

	if _, ok := store.take(token); ok {
		t.Error("expected second take to return ok=false (one-shot semantics)")
	}
}

func TestUndoBatchStore_PeekDoesNotConsume(t *testing.T) {
	store := newUndoBatchStore()
	token, err := store.put(undoBatchEntry{
		chatID:     1,
		messageID:  2,
		foodLogIDs: []int64{99},
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	got, ok := store.peek(token)
	if !ok {
		t.Fatal("expected peek to return the entry")
	}
	if got.messageID != 2 {
		t.Errorf("peek messageID: want 2, got %d", got.messageID)
	}

	if _, ok := store.peek(token); !ok {
		t.Error("expected second peek to still find the entry (non-consuming)")
	}

	if _, ok := store.take(token); !ok {
		t.Error("expected take after peek to still consume the entry")
	}
	if _, ok := store.peek(token); ok {
		t.Error("expected peek after take to return ok=false")
	}
}

func TestUndoBatchStore_SetMessageIDUpdatesExistingEntry(t *testing.T) {
	store := newUndoBatchStore()
	token, err := store.put(undoBatchEntry{chatID: 5, foodLogIDs: []int64{1}})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	if ok := store.setMessageID(token, 999); !ok {
		t.Fatal("setMessageID returned ok=false for a freshly put entry")
	}

	got, ok := store.peek(token)
	if !ok {
		t.Fatal("expected entry to still exist after setMessageID (non-consuming)")
	}
	if got.messageID != 999 {
		t.Errorf("messageID: want 999, got %d", got.messageID)
	}
	if got.chatID != 5 {
		t.Errorf("chatID should be preserved, got %d", got.chatID)
	}
}

func TestUndoBatchStore_SetMessageIDOnUnknownToken(t *testing.T) {
	store := newUndoBatchStore()
	if ok := store.setMessageID("missing", 1); ok {
		t.Error("setMessageID should return ok=false for unknown token")
	}
}

func TestUndoBatchStore_SetMessageIDOnExpiredToken(t *testing.T) {
	store := newUndoBatchStore()
	current := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return current }

	token, err := store.put(undoBatchEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	current = current.Add(undoBatchTTL + time.Second)

	if ok := store.setMessageID(token, 42); ok {
		t.Error("setMessageID should return ok=false for an expired entry")
	}

	store.mu.Lock()
	_, stillPresent := store.entries[token]
	store.mu.Unlock()
	if stillPresent {
		t.Error("expected setMessageID to evict an expired entry it found")
	}
}

func TestUndoBatchStore_TakeUnknownToken(t *testing.T) {
	store := newUndoBatchStore()
	if _, ok := store.take("nope"); ok {
		t.Error("expected take of unknown token to return ok=false")
	}
	if _, ok := store.peek("nope"); ok {
		t.Error("expected peek of unknown token to return ok=false")
	}
}

func TestUndoBatchStore_DefaultTTLSetOnPut(t *testing.T) {
	store := newUndoBatchStore()
	fixed := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return fixed }

	token, err := store.put(undoBatchEntry{chatID: 1, messageID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	store.mu.Lock()
	got := store.entries[token]
	store.mu.Unlock()

	wantExpiry := fixed.Add(undoBatchTTL)
	if !got.expiresAt.Equal(wantExpiry) {
		t.Errorf("expiresAt: want %v, got %v", wantExpiry, got.expiresAt)
	}
	if undoBatchTTL > time.Minute {
		t.Errorf("undoBatchTTL must be <= 1 minute, got %v", undoBatchTTL)
	}
}

func TestUndoBatchStore_ExpiredEntryNotReturnedByTake(t *testing.T) {
	store := newUndoBatchStore()
	current := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return current }

	token, err := store.put(undoBatchEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	current = current.Add(undoBatchTTL + time.Second)

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

func TestUndoBatchStore_ExpiredEntryNotReturnedByPeek(t *testing.T) {
	store := newUndoBatchStore()
	current := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return current }

	token, err := store.put(undoBatchEntry{chatID: 1})
	if err != nil {
		t.Fatalf("put: %v", err)
	}

	current = current.Add(undoBatchTTL + time.Second)

	if _, ok := store.peek(token); ok {
		t.Error("expected peek of expired token to return ok=false")
	}

	store.mu.Lock()
	_, stillPresent := store.entries[token]
	store.mu.Unlock()
	if stillPresent {
		t.Error("expected expired entry to be evicted by peek")
	}
}

func TestUndoBatchStore_ConcurrentAccessRaceSafe(t *testing.T) {
	store := newUndoBatchStore()

	const writers = 8
	const perWriter = 50
	tokens := make(chan string, writers*perWriter)
	var wg sync.WaitGroup

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				tok, err := store.put(undoBatchEntry{
					chatID:     int64(i),
					messageID:  i,
					foodLogIDs: []int64{int64(i)},
				})
				if err != nil {
					t.Errorf("put: %v", err)
					return
				}
				tokens <- tok
			}
		}()
	}

	var peeked int64
	var taken int64
	var consumers sync.WaitGroup
	for r := 0; r < writers; r++ {
		consumers.Add(1)
		go func() {
			defer consumers.Done()
			for tok := range tokens {
				if _, ok := store.peek(tok); ok {
					atomic.AddInt64(&peeked, 1)
				}
				if _, ok := store.take(tok); ok {
					atomic.AddInt64(&taken, 1)
				}
			}
		}()
	}

	wg.Wait()
	close(tokens)
	consumers.Wait()

	if got, want := atomic.LoadInt64(&taken), int64(writers*perWriter); got != want {
		t.Errorf("taken count: want %d, got %d", want, got)
	}
	if got, want := atomic.LoadInt64(&peeked), int64(writers*perWriter); got != want {
		t.Errorf("peeked count: want %d, got %d", want, got)
	}
}
