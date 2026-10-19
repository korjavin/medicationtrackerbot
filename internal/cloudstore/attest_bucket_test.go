package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/pressly/goose/v3"
)

// Migration 029 (bd med-o7zq.26) on a database at 028 with an install that
// spent part of its trial: it gets its own bucket and keeps every counter —
// lifetime and voice seconds, and today's request, food and voice rows.
func TestMigration029BackfillsBuckets(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	day := now.Format("2006-01-02")
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
	if err := goose.UpTo(d.DB, "migrations", 28); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO attest_installs (key_id, public_key, counter, used, env, created_at, last_seen_at, voice_seconds) VALUES ('old', x'01', 7, 3, 'production', 1, 1, 100)`,
		`INSERT INTO trial_usage (day, account_id, requests) VALUES ('` + day + `', 'attest:old', 2), ('` + day + `', 'attest-food:old', 1)`,
		`INSERT INTO attest_voice_usage (day, key_id, seconds) VALUES ('` + day + `', 'old', 50)`,
	} {
		if _, err := d.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	r, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	in, err := r.AttestInstall(ctx, "old")
	if err != nil || in.BucketID != "old" || in.Used != 3 || in.Counter != 7 {
		t.Fatalf("migrated install: %+v %v", in, err)
	}
	if h, err := r.AttestBucketPassHash(ctx, "old"); err != nil || h != nil {
		t.Fatalf("backfilled bucket has a pass: %x %v", h, err)
	}
	// Lifetime 4: one left. Daily 3: today's 2 count, so the one left is allowed.
	if ok, _, rem, err := r.ConsumeAttestRequest(ctx, "old", 8, now, 4, 3, 0); !ok || rem != 0 || err != nil {
		t.Fatalf("lifetime after backfill: ok=%v rem=%d %v", ok, rem, err)
	}
	if _, scope, _, _ := r.ConsumeAttestRequest(ctx, "old", 9, now, 10, 3, 0); scope != AttestScopeInstallDay {
		t.Fatalf("daily after backfill: %q", scope)
	}
	if ok, _ := r.ConsumeAttestFoodRequest(ctx, "old", 10, now, 1); ok {
		t.Fatal("food daily reset by the backfill")
	}
	if used, _ := r.AttestVoiceUsed(ctx, "old"); used != 100 {
		t.Fatalf("voice seconds: %d", used)
	}
	// Voice daily 80: 50 used today → 30 left.
	if grant, _, _, _, err := r.ReserveAttestVoice(ctx, "old", 11, now, 600, 80, 0, 120, 30); grant != 30 || err != nil {
		t.Fatalf("voice daily after backfill: %d %v", grant, err)
	}
}

// bd med-o7zq.26: an install that joins a bucket spends the bucket's
// counters; a rolled-back founding install takes its bucket with it.
func TestAttestBucketShared(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	r := setupRepo(t)
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k1", PublicKey: []byte{1}, PassHash: []byte{9}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k2", BucketID: "k1", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k3", BucketID: "nope", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err == nil {
		t.Fatal("joined an unknown bucket")
	}
	if ok, _, _, _ := r.ConsumeAttestRequest(ctx, "k1", 1, now, 2, 0, 0); !ok {
		t.Fatal("k1 refused")
	}
	if ok, _, rem, _ := r.ConsumeAttestRequest(ctx, "k2", 1, now, 2, 0, 0); !ok || rem != 0 {
		t.Fatalf("k2: ok=%v rem=%d", ok, rem)
	}
	if _, scope, _, _ := r.ConsumeAttestRequest(ctx, "k1", 2, now, 2, 0, 0); scope != AttestScopeInstall {
		t.Fatalf("shared lifetime: %q", scope)
	}
	if err := r.RefundAttestRequest(ctx, "k2"); err != nil {
		t.Fatal(err)
	}
	if in, _ := r.AttestInstall(ctx, "k1"); in.Used != 1 {
		t.Fatalf("refund on the bucket: %+v", in)
	}
	if g, _, _, _, _ := r.ReserveAttestVoice(ctx, "k1", 3, now, 60, 0, 0, 60, 30); g != 60 {
		t.Fatalf("k1 voice: %d", g)
	}
	if g, scope, _, _, _ := r.ReserveAttestVoice(ctx, "k2", 2, now, 60, 0, 0, 60, 30); g != 0 || scope != AttestScopeVoice {
		t.Fatalf("shared voice: %d %q", g, scope)
	}
	if err := r.RefundAttestVoice(ctx, "k2", now, 60); err != nil {
		t.Fatal(err)
	}
	if used, _ := r.AttestVoiceUsed(ctx, "k1"); used != 0 {
		t.Fatalf("voice refund on the bucket: %d", used)
	}

	// Rollback: a founding install alone takes its bucket; a bucket another
	// install joined stays.
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "solo", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.DeleteAttestInstall(ctx, "solo"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AttestBucketPassHash(ctx, "solo"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("bucket kept after rollback: %v", err)
	}
	if err := r.DeleteAttestInstall(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	if in, err := r.AttestInstall(ctx, "k2"); err != nil || in.Used != 1 {
		t.Fatalf("joined install lost its bucket: %+v %v", in, err)
	}
}
