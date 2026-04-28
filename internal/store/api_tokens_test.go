package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateAPIToken(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	id, err := db.CreateAPIToken(ctx, "ci-bot", "hash-1")
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	if id <= 0 {
		t.Fatalf("expected positive id, got %d", id)
	}
}

func TestCreateAPIToken_DuplicateHashFails(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	if _, err := db.CreateAPIToken(ctx, "first", "shared-hash"); err != nil {
		t.Fatalf("first CreateAPIToken: %v", err)
	}
	_, err := db.CreateAPIToken(ctx, "second", "shared-hash")
	if err == nil {
		t.Fatalf("expected uniqueness violation, got nil")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "unique") {
		t.Fatalf("expected unique-constraint error, got %v", err)
	}
}

func TestListAPITokens(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	tokens, err := db.ListAPITokens(ctx)
	if err != nil {
		t.Fatalf("ListAPITokens empty: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatalf("expected empty list, got %d", len(tokens))
	}

	id1, err := db.CreateAPIToken(ctx, "alpha", "h1")
	if err != nil {
		t.Fatalf("CreateAPIToken alpha: %v", err)
	}
	id2, err := db.CreateAPIToken(ctx, "beta", "h2")
	if err != nil {
		t.Fatalf("CreateAPIToken beta: %v", err)
	}

	tokens, err = db.ListAPITokens(ctx)
	if err != nil {
		t.Fatalf("ListAPITokens: %v", err)
	}
	if len(tokens) != 2 {
		t.Fatalf("expected 2 tokens, got %d", len(tokens))
	}
	if tokens[0].ID != id1 || tokens[0].Name != "alpha" {
		t.Errorf("first token: got id=%d name=%q, want id=%d name=%q",
			tokens[0].ID, tokens[0].Name, id1, "alpha")
	}
	if tokens[1].ID != id2 || tokens[1].Name != "beta" {
		t.Errorf("second token: got id=%d name=%q, want id=%d name=%q",
			tokens[1].ID, tokens[1].Name, id2, "beta")
	}
	if tokens[0].LastUsedAt.Valid {
		t.Errorf("expected LastUsedAt to be NULL on creation")
	}
	if tokens[0].CreatedAt.IsZero() {
		t.Errorf("expected CreatedAt to be populated")
	}
}

func TestDeleteAPIToken(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	id, err := db.CreateAPIToken(ctx, "to-delete", "h-del")
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	if err := db.DeleteAPIToken(ctx, id); err != nil {
		t.Fatalf("DeleteAPIToken: %v", err)
	}

	tokens, err := db.ListAPITokens(ctx)
	if err != nil {
		t.Fatalf("ListAPITokens after delete: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatalf("expected 0 tokens after delete, got %d", len(tokens))
	}
}

func TestDeleteAPIToken_MissingReturnsErrNoRows(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	err := db.DeleteAPIToken(ctx, 99999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestFindAPITokenByHash(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	id, err := db.CreateAPIToken(ctx, "lookup", "find-me")
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	tok, err := db.FindAPITokenByHash(ctx, "find-me")
	if err != nil {
		t.Fatalf("FindAPITokenByHash: %v", err)
	}
	if tok == nil {
		t.Fatalf("expected token, got nil")
	}
	if tok.ID != id || tok.Name != "lookup" {
		t.Errorf("got id=%d name=%q, want id=%d name=%q", tok.ID, tok.Name, id, "lookup")
	}
}

func TestFindAPITokenByHash_NotFound(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	tok, err := db.FindAPITokenByHash(ctx, "no-such-hash")
	if err != nil {
		t.Fatalf("FindAPITokenByHash: %v", err)
	}
	if tok != nil {
		t.Fatalf("expected nil token, got %+v", tok)
	}
}

// TestFindAPITokenByHash_MultiRow ensures the lookup actually filters by
// token_hash (not by id, name, or "first row") when multiple tokens exist.
func TestFindAPITokenByHash_MultiRow(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	idA, err := db.CreateAPIToken(ctx, "alpha", "hash-A")
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	idB, err := db.CreateAPIToken(ctx, "beta", "hash-B")
	if err != nil {
		t.Fatalf("create beta: %v", err)
	}

	got, err := db.FindAPITokenByHash(ctx, "hash-B")
	if err != nil {
		t.Fatalf("find hash-B: %v", err)
	}
	if got == nil {
		t.Fatalf("expected to find beta")
	}
	if got.ID != idB || got.Name != "beta" {
		t.Errorf("hash-B lookup returned id=%d name=%q, want id=%d name=%q",
			got.ID, got.Name, idB, "beta")
	}

	got, err = db.FindAPITokenByHash(ctx, "hash-A")
	if err != nil {
		t.Fatalf("find hash-A: %v", err)
	}
	if got == nil {
		t.Fatalf("expected to find alpha")
	}
	if got.ID != idA || got.Name != "alpha" {
		t.Errorf("hash-A lookup returned id=%d name=%q, want id=%d name=%q",
			got.ID, got.Name, idA, "alpha")
	}
}

func TestTouchAPITokenLastUsed(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)

	id, err := db.CreateAPIToken(ctx, "touch", "h-touch")
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	before, err := db.FindAPITokenByHash(ctx, "h-touch")
	if err != nil {
		t.Fatalf("FindAPITokenByHash before: %v", err)
	}
	if before.LastUsedAt.Valid {
		t.Fatalf("expected LastUsedAt NULL before touch, got %v", before.LastUsedAt.Time)
	}

	// Sleep to ensure CURRENT_TIMESTAMP differs from CreatedAt by at least
	// one second of resolution if needed.
	time.Sleep(10 * time.Millisecond)

	if err := db.TouchAPITokenLastUsed(ctx, id); err != nil {
		t.Fatalf("TouchAPITokenLastUsed: %v", err)
	}

	after, err := db.FindAPITokenByHash(ctx, "h-touch")
	if err != nil {
		t.Fatalf("FindAPITokenByHash after: %v", err)
	}
	if !after.LastUsedAt.Valid {
		t.Fatalf("expected LastUsedAt populated after touch")
	}
}
