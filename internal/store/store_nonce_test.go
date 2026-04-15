package store

import (
	"testing"
	"time"
)

func TestTryUseLoginHash(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	hash := "abc123deadbeef"
	expiresAt := time.Now().Add(24 * time.Hour)

	// First use should succeed
	fresh, err := db.TryUseLoginHash(hash, expiresAt)
	if err != nil {
		t.Fatalf("TryUseLoginHash first call: %v", err)
	}
	if !fresh {
		t.Error("expected first use to return fresh=true")
	}

	// Replay should fail
	fresh, err = db.TryUseLoginHash(hash, expiresAt)
	if err != nil {
		t.Fatalf("TryUseLoginHash replay call: %v", err)
	}
	if fresh {
		t.Error("expected replay to return fresh=false")
	}

	// Different hash should succeed
	fresh, err = db.TryUseLoginHash("different_hash", expiresAt)
	if err != nil {
		t.Fatalf("TryUseLoginHash different hash: %v", err)
	}
	if !fresh {
		t.Error("expected different hash to return fresh=true")
	}
}

func TestTryUseLoginHash_ExpiredPruning(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	hash := "expired_hash"
	// Insert with an already-expired time
	expiresAt := time.Now().Add(-1 * time.Hour)

	fresh, err := db.TryUseLoginHash(hash, expiresAt)
	if err != nil {
		t.Fatalf("TryUseLoginHash: %v", err)
	}
	if !fresh {
		t.Error("expected first use to return fresh=true even with past expiry")
	}

	// The entry is now in the table but expired. Next call should prune it
	// and allow the same hash to be reused.
	fresh, err = db.TryUseLoginHash(hash, expiresAt)
	if err != nil {
		t.Fatalf("TryUseLoginHash after prune: %v", err)
	}
	if !fresh {
		t.Error("expected hash to be reusable after expiry pruning")
	}
}
