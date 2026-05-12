package bot

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// pendingPhotoTTL is how long a photo waits in pendingPhotoStore for the user
// to answer the "use photo time or use now?" prompt before it's dropped.
const pendingPhotoTTL = 10 * time.Minute

// pendingPhotoEntry holds an in-flight food photo awaiting a time-picker
// answer from the user. The photo bytes are kept in memory because callbacks
// from Telegram arrive on a different message and we'd otherwise need to
// re-download via GetFile.
type pendingPhotoEntry struct {
	chatID     int64
	imageBytes []byte
	mimeType   string
	exifTime   time.Time
	expiresAt  time.Time
}

// pendingPhotoStore is a one-shot, TTL-bounded cache keyed by random tokens.
// Tokens are crypto-random 16-byte hex strings that fit Telegram's 64-byte
// callback_data cap (16 + colon + prefix + ... < 64).
type pendingPhotoStore struct {
	mu      sync.Mutex
	entries map[string]pendingPhotoEntry
	now     func() time.Time
}

func newPendingPhotoStore() *pendingPhotoStore {
	return &pendingPhotoStore{
		entries: make(map[string]pendingPhotoEntry),
		now:     time.Now,
	}
}

// put stores entry under a freshly minted token and returns the token. The
// caller is expected to embed the token in callback_data; later, the callback
// handler calls take(token) to retrieve and consume the entry.
func (s *pendingPhotoStore) put(entry pendingPhotoEntry) (string, error) {
	token, err := newPendingPhotoToken()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry.expiresAt.IsZero() {
		entry.expiresAt = s.now().Add(pendingPhotoTTL)
	}
	s.entries[token] = entry
	return token, nil
}

// take returns the entry stored under token and removes it. Returns ok=false
// when the token is unknown or expired (in which case the expired entry is
// also removed).
func (s *pendingPhotoStore) take(token string) (pendingPhotoEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[token]
	if !ok {
		return pendingPhotoEntry{}, false
	}
	delete(s.entries, token)
	if !entry.expiresAt.IsZero() && !s.now().Before(entry.expiresAt) {
		return pendingPhotoEntry{}, false
	}
	return entry, true
}

// gcExpired removes any entries whose expiresAt is at or before now. Safe to
// call from a background sweeper or a synchronous TTL test.
func (s *pendingPhotoStore) gcExpired(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, entry := range s.entries {
		if !entry.expiresAt.IsZero() && !now.Before(entry.expiresAt) {
			delete(s.entries, token)
		}
	}
}

func newPendingPhotoToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
