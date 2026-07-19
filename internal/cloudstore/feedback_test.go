package cloudstore

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

func TestFeedbackQueue(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)

	t.Run("append then list round-trips ciphertext verbatim", func(t *testing.T) {
		r := setupRepo(t)
		ct := []byte{0x00, 0x01, 0xfe, 0xff, 'a', 'g', 'e'}
		if err := r.AppendFeedback(ctx, "acc-1", "cid-1", "bug", "1.2.3", ct, now); err != nil {
			t.Fatalf("AppendFeedback: %v", err)
		}
		items, err := r.ListFeedback(ctx, 10)
		if err != nil {
			t.Fatalf("ListFeedback: %v", err)
		}
		if len(items) != 1 {
			t.Fatalf("len = %d, want 1", len(items))
		}
		it := items[0]
		if it.AccountID != "acc-1" || it.ClientID != "cid-1" || it.Kind != "bug" || it.AppVersion != "1.2.3" {
			t.Errorf("unexpected item: %+v", it)
		}
		if !bytes.Equal(it.Ciphertext, ct) {
			t.Errorf("ciphertext = %v, want %v", it.Ciphertext, ct)
		}
		if !it.CreatedAt.Equal(now) {
			t.Errorf("createdAt = %v, want %v", it.CreatedAt, now)
		}
	})

	t.Run("duplicate client_id is a no-op", func(t *testing.T) {
		r := setupRepo(t)
		if err := r.AppendFeedback(ctx, "acc-1", "dup", "", "", []byte("first"), now); err != nil {
			t.Fatalf("AppendFeedback 1: %v", err)
		}
		if err := r.AppendFeedback(ctx, "acc-1", "dup", "", "", []byte("second"), now.Add(time.Hour)); err != nil {
			t.Fatalf("AppendFeedback 2: %v", err)
		}
		items, err := r.ListFeedback(ctx, 10)
		if err != nil {
			t.Fatalf("ListFeedback: %v", err)
		}
		if len(items) != 1 {
			t.Fatalf("len = %d, want 1 (dedupe on client_id)", len(items))
		}
		if !bytes.Equal(items[0].Ciphertext, []byte("first")) {
			t.Errorf("ciphertext = %q, want first-write to win", items[0].Ciphertext)
		}
	})

	t.Run("same client_id under two accounts both stored (per-account scope)", func(t *testing.T) {
		r := setupRepo(t)
		if err := r.AppendFeedback(ctx, "acc-1", "shared", "", "", []byte("a1"), now); err != nil {
			t.Fatalf("AppendFeedback acc-1: %v", err)
		}
		if err := r.AppendFeedback(ctx, "acc-2", "shared", "", "", []byte("a2"), now.Add(time.Minute)); err != nil {
			t.Fatalf("AppendFeedback acc-2: %v", err)
		}
		items, err := r.ListFeedback(ctx, 10)
		if err != nil {
			t.Fatalf("ListFeedback: %v", err)
		}
		if len(items) != 2 {
			t.Fatalf("len = %d, want 2 (client_id unique is per-account, not global)", len(items))
		}
	})

	t.Run("delete removes the row", func(t *testing.T) {
		r := setupRepo(t)
		if err := r.AppendFeedback(ctx, "acc-1", "cid-del", "", "", []byte("x"), now); err != nil {
			t.Fatalf("AppendFeedback: %v", err)
		}
		items, _ := r.ListFeedback(ctx, 10)
		if len(items) != 1 {
			t.Fatalf("setup: len = %d", len(items))
		}
		if err := r.DeleteFeedback(ctx, items[0].ID); err != nil {
			t.Fatalf("DeleteFeedback: %v", err)
		}
		items, _ = r.ListFeedback(ctx, 10)
		if len(items) != 0 {
			t.Fatalf("after delete len = %d, want 0", len(items))
		}
		// deleting a gone row is a no-op
		if err := r.DeleteFeedback(ctx, 999999); err != nil {
			t.Fatalf("DeleteFeedback missing: %v", err)
		}
	})

	t.Run("new submissions past the per-account cap are rejected", func(t *testing.T) {
		r := setupRepo(t)
		for i := 0; i < feedbackPerAccountCap; i++ {
			cid := "cap-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
			if err := r.AppendFeedback(ctx, "acc-1", cid, "", "", []byte("x"), now); err != nil {
				t.Fatalf("AppendFeedback %d: %v", i, err)
			}
		}
		if err := r.AppendFeedback(ctx, "acc-1", "one-too-many", "", "", []byte("x"), now); !errors.Is(err, ErrFeedbackQueueFull) {
			t.Fatalf("over-cap append err = %v, want ErrFeedbackQueueFull", err)
		}
		// A retry of an already-queued client_id still succeeds at the cap.
		if err := r.AppendFeedback(ctx, "acc-1", "cap-a0", "", "", []byte("x"), now); err != nil {
			t.Fatalf("idempotent retry at cap: %v", err)
		}
		// The cap is per-account: a different account is unaffected.
		if err := r.AppendFeedback(ctx, "acc-2", "fresh", "", "", []byte("x"), now); err != nil {
			t.Fatalf("other-account append at acc-1 cap: %v", err)
		}
	})

	t.Run("list respects limit and ASC order", func(t *testing.T) {
		r := setupRepo(t)
		for i, cid := range []string{"c0", "c1", "c2"} {
			ts := now.Add(time.Duration(i) * time.Minute)
			if err := r.AppendFeedback(ctx, "acc-1", cid, "", "", []byte(cid), ts); err != nil {
				t.Fatalf("AppendFeedback %s: %v", cid, err)
			}
		}
		items, err := r.ListFeedback(ctx, 2)
		if err != nil {
			t.Fatalf("ListFeedback: %v", err)
		}
		if len(items) != 2 {
			t.Fatalf("len = %d, want 2 (limit)", len(items))
		}
		if items[0].ClientID != "c0" || items[1].ClientID != "c1" {
			t.Errorf("order = %s,%s, want c0,c1 (ASC)", items[0].ClientID, items[1].ClientID)
		}
	})
}
