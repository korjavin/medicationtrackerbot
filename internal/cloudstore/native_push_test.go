package cloudstore

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// bd med-erq1.1: the native push token registry — upsert, re-register under
// another account moves the row, disable/re-enable, scoped delete.
func TestNativePushTokens(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	t0 := time.Unix(1_700_000_000, 0).UTC()

	tokens := func(account string) []NativePushToken {
		t.Helper()
		got, err := r.ListNativePushTokens(ctx, account)
		if err != nil {
			t.Fatalf("ListNativePushTokens: %v", err)
		}
		return got
	}

	if err := r.UpsertNativePushToken(ctx, "acct-a", NativePushIOS, "tok1", t0); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := r.UpsertNativePushToken(ctx, "acct-a", NativePushAndroid, "tok2", t0); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if got := tokens("acct-a"); len(got) != 2 {
		t.Fatalf("acct-a tokens = %+v, want 2", got)
	}
	// An unknown platform is refused by the CHECK constraint.
	if err := r.UpsertNativePushToken(ctx, "acct-a", "webos", "tok3", t0); err == nil {
		t.Fatal("upsert with platform webos succeeded, want CHECK failure")
	}

	// Disable hides the token; a re-register re-enables it and bumps last_seen
	// but keeps created_at.
	if err := r.DisableNativePushToken(ctx, NativePushIOS, "tok1"); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if got := tokens("acct-a"); len(got) != 1 || got[0].Token != "tok2" {
		t.Fatalf("after disable, acct-a tokens = %+v, want only tok2", got)
	}
	t1 := t0.Add(time.Hour)
	if err := r.UpsertNativePushToken(ctx, "acct-a", NativePushIOS, "tok1", t1); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	for _, tok := range tokens("acct-a") {
		if tok.Token == "tok1" && (!tok.LastSeen.Equal(t1) || !tok.CreatedAt.Equal(t0)) {
			t.Fatalf("re-registered tok1 = %+v, want created %v last_seen %v", tok, t0, t1)
		}
	}

	// Same device, new account: the row moves.
	if err := r.UpsertNativePushToken(ctx, "acct-b", NativePushIOS, "tok1", t1); err != nil {
		t.Fatalf("upsert under acct-b: %v", err)
	}
	if got := tokens("acct-a"); len(got) != 1 || got[0].Token != "tok2" {
		t.Fatalf("after move, acct-a tokens = %+v, want only tok2", got)
	}
	if got := tokens("acct-b"); len(got) != 1 || got[0].Token != "tok1" || got[0].Platform != NativePushIOS {
		t.Fatalf("after move, acct-b tokens = %+v, want ios tok1", got)
	}

	// Delete is scoped to the account: acct-a cannot delete acct-b's token.
	if err := r.DeleteNativePushToken(ctx, "acct-a", NativePushIOS, "tok1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := tokens("acct-b"); len(got) != 1 {
		t.Fatalf("cross-account delete removed acct-b's token: %+v", got)
	}
	if err := r.DeleteNativePushToken(ctx, "acct-b", NativePushIOS, "tok1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := tokens("acct-b"); len(got) != 0 {
		t.Fatalf("after delete, acct-b tokens = %+v, want none", got)
	}
}

// bd med-erq1.2: an account keeps only its most recently seen tokens.
func TestNativePushTokens_PerAccountCap(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	t0 := time.Unix(1_700_000_000, 0).UTC()
	for i := 0; i <= MaxNativePushTokensPerAccount; i++ {
		if err := r.UpsertNativePushToken(ctx, "acct-a", NativePushIOS, fmt.Sprintf("tok%02d", i), t0.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatalf("upsert %d: %v", i, err)
		}
	}
	if err := r.UpsertNativePushToken(ctx, "acct-b", NativePushIOS, "other", t0); err != nil {
		t.Fatalf("upsert acct-b: %v", err)
	}
	got, err := r.ListNativePushTokens(ctx, "acct-a")
	if err != nil {
		t.Fatalf("ListNativePushTokens: %v", err)
	}
	if len(got) != MaxNativePushTokensPerAccount {
		t.Fatalf("tokens = %d, want %d", len(got), MaxNativePushTokensPerAccount)
	}
	for _, tok := range got {
		if tok.Token == "tok00" {
			t.Fatal("the least recently seen token survived the cap")
		}
	}
	if other, _ := r.ListNativePushTokens(ctx, "acct-b"); len(other) != 1 {
		t.Fatalf("acct-b tokens = %+v, want its one token untouched", other)
	}
}
