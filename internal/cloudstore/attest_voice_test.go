package cloudstore

import (
	"context"
	"errors"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/pressly/goose/v3"
)

// bd med-o7zq.22: voice seconds reserved up front, refunded on settle; the
// AI budget (trial_usage) is never touched.
func TestReserveAttestVoice(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 18, 23, 59, 0, 0, time.UTC)
	r := setupRepo(t)
	for _, k := range []string{"k1", "k2"} {
		if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: k, PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	// lifetime 600, daily 300 caps the grant.
	grant, scope, rem, day, err := r.ReserveAttestVoice(ctx, "k1", 1, now, 600, 300, 0, 600, 30)
	if err != nil || grant != 300 || scope != "" || rem != 300 || day != 0 {
		t.Fatalf("first: grant=%d scope=%q rem=%d day=%d err=%v", grant, scope, rem, day, err)
	}
	if _, _, _, _, err := r.ReserveAttestVoice(ctx, "k1", 1, now, 600, 300, 0, 600, 30); !errors.Is(err, ErrAttestCounter) {
		t.Fatalf("replayed counter: %v", err)
	}
	if _, scope, _, _, _ := r.ReserveAttestVoice(ctx, "k1", 2, now, 600, 300, 0, 600, 30); scope != AttestScopeVoiceDay {
		t.Fatalf("daily scope = %q", scope)
	}
	// Settle at 90 s across midnight: the refund lands on the reservation day.
	if err := r.RefundAttestVoice(ctx, "k1", now, 210); err != nil {
		t.Fatal(err)
	}
	if used, _ := r.AttestVoiceUsed(ctx, "k1"); used != 90 {
		t.Fatalf("used after refund = %d", used)
	}
	// Global (k1 90 today) shared across installs: 100 - 90 < 30.
	if _, scope, _, _, _ := r.ReserveAttestVoice(ctx, "k2", 1, now, 600, 0, 100, 600, 30); scope != TrialScopeGlobal {
		t.Fatalf("global scope = %q", scope)
	}
	// Lifetime first: 100 lifetime - 90 used < 30.
	if _, scope, _, _, _ := r.ReserveAttestVoice(ctx, "k1", 3, now, 100, 0, 0, 600, 30); scope != AttestScopeVoice {
		t.Fatalf("lifetime scope = %q", scope)
	}
	// A refund never goes below zero.
	if err := r.RefundAttestVoice(ctx, "k1", now, 1000); err != nil {
		t.Fatal(err)
	}
	if used, _ := r.AttestVoiceUsed(ctx, "k1"); used != 0 {
		t.Fatalf("used after over-refund = %d", used)
	}
	// Voice spent no AI request budget.
	if ok, _, _ := r.ConsumeTrialRequest(ctx, "acct", now, 0, 1); !ok {
		t.Fatal("voice spent the AI global budget")
	}
}

// Migration 028 on a database at 027 with an existing install: the row keeps
// working and starts with the full voice budget.
func TestMigration028OnExistingInstalls(t *testing.T) {
	ctx := context.Background()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.UpTo(d.DB, "migrations", 27); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(ctx, `INSERT INTO attest_installs (key_id, public_key, counter, used, env, created_at, last_seen_at) VALUES ('old', x'01', 7, 3, 'production', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	r, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if used, err := r.AttestVoiceUsed(ctx, "old"); err != nil || used != 0 {
		t.Fatalf("voice_seconds = %d %v", used, err)
	}
	grant, _, _, _, err := r.ReserveAttestVoice(ctx, "old", 8, time.Now(), 600, 300, 7200, 600, 30)
	if err != nil || grant != 300 {
		t.Fatalf("reserve on migrated row: %d %v", grant, err)
	}
}
