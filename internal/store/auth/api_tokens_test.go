package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

func setupAuthRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func TestCreateToken(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	id, err := r.CreateToken(ctx, "ci-bot", "hash-1")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	if id <= 0 {
		t.Fatalf("expected positive id, got %d", id)
	}
}

func TestCreateToken_DuplicateHashFails(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	if _, err := r.CreateToken(ctx, "first", "shared-hash"); err != nil {
		t.Fatalf("first CreateToken: %v", err)
	}
	_, err := r.CreateToken(ctx, "second", "shared-hash")
	if err == nil {
		t.Fatalf("expected uniqueness violation, got nil")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "unique") {
		t.Fatalf("expected unique-constraint error, got %v", err)
	}
}

func TestListTokens(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	tokens, err := r.ListTokens(ctx)
	if err != nil {
		t.Fatalf("ListTokens empty: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatalf("expected empty list, got %d", len(tokens))
	}

	id1, err := r.CreateToken(ctx, "alpha", "h1")
	if err != nil {
		t.Fatalf("CreateToken alpha: %v", err)
	}
	id2, err := r.CreateToken(ctx, "beta", "h2")
	if err != nil {
		t.Fatalf("CreateToken beta: %v", err)
	}

	tokens, err = r.ListTokens(ctx)
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
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

func TestDeleteToken(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	id, err := r.CreateToken(ctx, "to-delete", "h-del")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}

	if err := r.DeleteToken(ctx, id); err != nil {
		t.Fatalf("DeleteToken: %v", err)
	}

	tokens, err := r.ListTokens(ctx)
	if err != nil {
		t.Fatalf("ListTokens after delete: %v", err)
	}
	if len(tokens) != 0 {
		t.Fatalf("expected 0 tokens after delete, got %d", len(tokens))
	}
}

func TestDeleteToken_MissingReturnsErrNoRows(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	err := r.DeleteToken(ctx, 99999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestGetTokenByHash(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	id, err := r.CreateToken(ctx, "lookup", "find-me")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}

	tok, err := r.GetTokenByHash(ctx, "find-me")
	if err != nil {
		t.Fatalf("GetTokenByHash: %v", err)
	}
	if tok == nil {
		t.Fatalf("expected token, got nil")
	}
	if tok.ID != id || tok.Name != "lookup" {
		t.Errorf("got id=%d name=%q, want id=%d name=%q", tok.ID, tok.Name, id, "lookup")
	}
}

func TestGetTokenByHash_NotFound(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	tok, err := r.GetTokenByHash(ctx, "no-such-hash")
	if err != nil {
		t.Fatalf("GetTokenByHash: %v", err)
	}
	if tok != nil {
		t.Fatalf("expected nil token, got %+v", tok)
	}
}

// TestGetTokenByHash_MultiRow ensures the lookup actually filters by
// token_hash (not by id, name, or "first row") when multiple tokens exist.
func TestGetTokenByHash_MultiRow(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	idA, err := r.CreateToken(ctx, "alpha", "hash-A")
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	idB, err := r.CreateToken(ctx, "beta", "hash-B")
	if err != nil {
		t.Fatalf("create beta: %v", err)
	}

	got, err := r.GetTokenByHash(ctx, "hash-B")
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

	got, err = r.GetTokenByHash(ctx, "hash-A")
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

func TestTouchTokenLastUsed(t *testing.T) {
	ctx := context.Background()
	r := setupAuthRepo(t)

	id, err := r.CreateToken(ctx, "touch", "h-touch")
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}

	before, err := r.GetTokenByHash(ctx, "h-touch")
	if err != nil {
		t.Fatalf("GetTokenByHash before: %v", err)
	}
	if before.LastUsedAt.Valid {
		t.Fatalf("expected LastUsedAt NULL before touch, got %v", before.LastUsedAt.Time)
	}

	// Sleep to ensure CURRENT_TIMESTAMP differs from CreatedAt by at least
	// one second of resolution if needed.
	time.Sleep(10 * time.Millisecond)

	if err := r.TouchTokenLastUsed(ctx, id); err != nil {
		t.Fatalf("TouchTokenLastUsed: %v", err)
	}

	after, err := r.GetTokenByHash(ctx, "h-touch")
	if err != nil {
		t.Fatalf("GetTokenByHash after: %v", err)
	}
	if !after.LastUsedAt.Valid {
		t.Fatalf("expected LastUsedAt populated after touch")
	}
}
