package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// bd med-nt9p.32.8.3: kind round-trips; a row inserted without one reads ios
// (the migration default every pre-Android row also gets).
func TestAttestInstallKind(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	r := setupRepo(t)
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "ios", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "and", Kind: AttestKindAndroid, PublicKey: []byte{1}, Env: "PLAY_RECOGNIZED", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{"ios": AttestKindIOS, "and": AttestKindAndroid} {
		if in, err := r.AttestInstall(ctx, id); err != nil || in.Kind != want {
			t.Fatalf("%s: %+v %v", id, in, err)
		}
	}
}

// bd med-o7zq.15: counter CAS + lifetime + daily + global in one tx.
func TestConsumeAttestRequest(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	r := setupRepo(t)
	if _, err := r.AttestInstall(ctx, "k1"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unknown key: %v", err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k1", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k1", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err == nil {
		t.Fatal("duplicate insert accepted")
	}

	ok, scope, rem, err := r.ConsumeAttestRequest(ctx, "k1", 1, now, 2, 0, 0)
	if err != nil || !ok || scope != "" || rem != 1 {
		t.Fatalf("first: ok=%v scope=%q rem=%d err=%v", ok, scope, rem, err)
	}
	if _, _, _, err := r.ConsumeAttestRequest(ctx, "k1", 1, now, 2, 0, 0); !errors.Is(err, ErrAttestCounter) {
		t.Fatalf("replayed counter: %v", err)
	}
	if err := r.RefundAttestRequest(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	for c := uint32(2); c <= 3; c++ {
		if ok, _, _, err := r.ConsumeAttestRequest(ctx, "k1", c, now, 2, 0, 0); !ok || err != nil {
			t.Fatalf("counter %d: ok=%v err=%v", c, ok, err)
		}
	}
	ok, scope, rem, err = r.ConsumeAttestRequest(ctx, "k1", 4, now, 2, 0, 0)
	if err != nil || ok || scope != AttestScopeInstall || rem != 0 {
		t.Fatalf("lifetime: ok=%v scope=%q rem=%d err=%v", ok, scope, rem, err)
	}
	// The refused call still spent its counter.
	if in, _ := r.AttestInstall(ctx, "k1"); in.Counter != 4 || in.Used != 2 {
		t.Fatalf("row after refusal: %+v", in)
	}

	// Daily per install, then the global budget shared with an account.
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k2", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if ok, _, _, _ := r.ConsumeAttestRequest(ctx, "k2", 1, now, 10, 1, 0); !ok {
		t.Fatal("k2 first refused")
	}
	if _, scope, _, _ := r.ConsumeAttestRequest(ctx, "k2", 2, now, 10, 1, 0); scope != AttestScopeInstallDay {
		t.Fatalf("daily scope = %q", scope)
	}
	// Today: k1 3 (refunds are lifetime-only) + k2 1 + one account request = 5.
	if ok, _, _ := r.ConsumeTrialRequest(ctx, "acct", now, 0, 0); !ok {
		t.Fatal("account refused")
	}
	if _, scope, _, _ := r.ConsumeAttestRequest(ctx, "k2", 3, now, 10, 5, 5); scope != TrialScopeGlobal {
		t.Fatalf("global scope = %q", scope)
	}
	if ok, scope, _ := r.ConsumeTrialRequest(ctx, "acct", now, 0, 5); ok || scope != TrialScopeGlobal {
		t.Fatalf("account sees shared global: ok=%v scope=%q", ok, scope)
	}
}
