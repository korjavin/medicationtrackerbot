package cloudstore

import (
	"context"
	"errors"
	"testing"
	"time"
)

func setupShareAccount(t *testing.T, r *Repo, id, subdomain string, now time.Time) {
	t.Helper()
	if _, err := r.CreateAccount(context.Background(), id, subdomain, []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount %s: %v", id, err)
	}
}

func TestShareLink_CreateReadRoundTrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()
	setupShareAccount(t, r, "sharer", "share-otter-abc123", now)

	ct := []byte("opaque-gcm-blob-bytes")
	created := now.Add(-time.Minute)
	expires := now.Add(30 * 24 * time.Hour)
	if err := r.CreateShareLink(ctx, "Ab3kZ9xQ2m", "sharer", ct, created, expires); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}

	gotCT, gotExp, err := r.ShareLink(ctx, "Ab3kZ9xQ2m", now)
	if err != nil {
		t.Fatalf("ShareLink: %v", err)
	}
	if string(gotCT) != string(ct) {
		t.Fatalf("ct mismatch: got %q want %q", gotCT, ct)
	}
	if !gotExp.Equal(expires.Truncate(time.Second)) && gotExp.Unix() != expires.Unix() {
		t.Fatalf("expires_at mismatch: got %v want %v", gotExp, expires)
	}

	// Unknown id reads exactly like an expired one.
	if _, _, err := r.ShareLink(ctx, "ZZZZZZZZZZ", now); !errors.Is(err, ErrShareLinkInvalid) {
		t.Fatalf("unknown id: expected ErrShareLinkInvalid, got %v", err)
	}

	// PK collision surfaces the typed error for the HTTP retry.
	if err := r.CreateShareLink(ctx, "Ab3kZ9xQ2m", "sharer", ct, created, expires); !errors.Is(err, ErrShareLinkExists) {
		t.Fatalf("duplicate id: expected ErrShareLinkExists, got %v", err)
	}
}

func TestShareLink_ExpiredReadsInvalid(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()
	setupShareAccount(t, r, "sharer", "share-otter-abc123", now)

	if err := r.CreateShareLink(ctx, "OldLink0001", "sharer", []byte("c"),
		now.Add(-31*24*time.Hour), now.Add(-24*time.Hour)); err != nil {
		t.Fatalf("CreateShareLink: %v", err)
	}
	if _, _, err := r.ShareLink(ctx, "OldLink0001", now); !errors.Is(err, ErrShareLinkInvalid) {
		t.Fatalf("expired link: expected ErrShareLinkInvalid, got %v", err)
	}
}

func TestShareLink_CountLiveAndSweep(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()
	setupShareAccount(t, r, "sharer", "share-otter-abc123", now)

	// Two live, one already expired.
	if err := r.CreateShareLink(ctx, "LiveLink001", "sharer", []byte("a"), now.Add(-time.Hour), now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateShareLink live1: %v", err)
	}
	if err := r.CreateShareLink(ctx, "LiveLink002", "sharer", []byte("b"), now.Add(-time.Hour), now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateShareLink live2: %v", err)
	}
	if err := r.CreateShareLink(ctx, "DeadLink003", "sharer", []byte("c"), now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("CreateShareLink dead: %v", err)
	}

	n, err := r.CountLiveShareLinks(ctx, "sharer", now)
	if err != nil {
		t.Fatalf("CountLiveShareLinks: %v", err)
	}
	if n != 2 {
		t.Fatalf("live count = %d, want 2", n)
	}

	swept, err := r.SweepExpiredShareLinks(ctx, now)
	if err != nil {
		t.Fatalf("SweepExpiredShareLinks: %v", err)
	}
	if swept != 1 {
		t.Fatalf("swept = %d, want 1", swept)
	}
	if _, _, err := r.ShareLink(ctx, "DeadLink003", now); !errors.Is(err, ErrShareLinkInvalid) {
		t.Fatalf("swept link: expected ErrShareLinkInvalid, got %v", err)
	}
}

func TestShareLink_AccountDeleteRemovesRows(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()
	setupShareAccount(t, r, "victim", "victim-otter-abc123", now)
	setupShareAccount(t, r, "bystander", "bystander-otter-def456", now)

	if err := r.CreateShareLink(ctx, "VictimLink1", "victim", []byte("v"), now, now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateShareLink victim: %v", err)
	}
	if err := r.CreateShareLink(ctx, "Bystander01", "bystander", []byte("b"), now, now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateShareLink bystander: %v", err)
	}

	if err := r.DeleteAccountByID(ctx, "victim"); err != nil {
		t.Fatalf("DeleteAccountByID: %v", err)
	}
	if n := countFor(t, r, "share_links", "victim"); n != 0 {
		t.Fatalf("victim share_links rows = %d, want 0", n)
	}
	if n := countFor(t, r, "share_links", "bystander"); n != 1 {
		t.Fatalf("bystander share_links rows = %d, want 1", n)
	}
}
