package bot

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// undoBatchTTL bounds the lifetime of an undo batch. The user-visible undo
// window is 5s; we keep the entry slightly longer so a click that races the
// expiry goroutine still resolves cleanly. Never longer than 1 minute.
const undoBatchTTL = 10 * time.Second

// undoBatchEntry tracks the food_log rows created from a single photo so the
// user can undo the whole batch with one button press. messageID points to
// the bot's summary message that hosts the inline [Undo] button.
type undoBatchEntry struct {
	chatID     int64
	messageID  int
	foodLogIDs []int64
	expiresAt  time.Time
}

// undoBatchStore is a TTL-bounded cache keyed by random tokens. take() is
// one-shot (consume); peek() is read-only and used by the 5s expiry goroutine
// to look up messageID without racing the user's click.
type undoBatchStore struct {
	mu      sync.Mutex
	entries map[string]undoBatchEntry
	now     func() time.Time
}

func newUndoBatchStore() *undoBatchStore {
	return &undoBatchStore{
		entries: make(map[string]undoBatchEntry),
		now:     time.Now,
	}
}

// put stores entry under a freshly minted token and returns the token.
func (s *undoBatchStore) put(entry undoBatchEntry) (string, error) {
	token, err := newUndoBatchToken()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry.expiresAt.IsZero() {
		entry.expiresAt = s.now().Add(undoBatchTTL)
	}
	s.entries[token] = entry
	return token, nil
}

// take returns the entry stored under token and removes it. Returns ok=false
// for unknown or expired tokens (in which case the expired entry is evicted).
func (s *undoBatchStore) take(token string) (undoBatchEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[token]
	if !ok {
		return undoBatchEntry{}, false
	}
	delete(s.entries, token)
	if !entry.expiresAt.IsZero() && !s.now().Before(entry.expiresAt) {
		return undoBatchEntry{}, false
	}
	return entry, true
}

// peek returns the entry stored under token without consuming it. Used by the
// 5-second expiry goroutine to look up the message ID for an edit-markup call
// while leaving the entry available to a racing user click.
func (s *undoBatchStore) peek(token string) (undoBatchEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[token]
	if !ok {
		return undoBatchEntry{}, false
	}
	if !entry.expiresAt.IsZero() && !s.now().Before(entry.expiresAt) {
		delete(s.entries, token)
		return undoBatchEntry{}, false
	}
	return entry, true
}

func newUndoBatchToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
