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
	// Rolling back copies the bucket's counters onto every install of it,
	// a rejoined one included.
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "joined", BucketID: "old", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(d.DB, "migrations", 28); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM attest_installs WHERE used = 4 AND voice_seconds = 130`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("rolled back counters: %d installs %v", n, err)
	}
}

// Migration 033 (bd med-ta2n.25): every bucket from before it reads granted;
// a feedback-only bucket is granted and revoked by SetAttestBucketGrant; the
// rollback drops feedback-only installs (an old server would treat them as
// trials) and keeps the granted ones.
func TestMigration033Granted(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
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
	if err := goose.UpTo(d.DB, "migrations", 31); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO attest_buckets (bucket_id, pass_hash, used, created_at) VALUES ('old', x'09', 2, 1)`,
		`INSERT INTO attest_installs (key_id, public_key, counter, used, env, created_at, last_seen_at, bucket_id) VALUES ('old', x'01', 1, 0, 'production', 1, 1, 'old')`,
	} {
		if _, err := d.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	r, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if in, err := r.AttestInstall(ctx, "old"); err != nil || !in.Granted || in.Used != 2 {
		t.Fatalf("pre-033 bucket: %+v %v", in, err)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "fb", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if in, _ := r.AttestInstall(ctx, "fb"); in.Granted {
		t.Fatal("feedback-only insert granted")
	}
	if err := r.SetAttestBucketGrant(ctx, "fb", []byte{7}); err != nil {
		t.Fatal(err)
	}
	if in, _ := r.AttestInstall(ctx, "fb"); !in.Granted {
		t.Fatal("grant not stored")
	}
	if err := r.SetAttestBucketGrant(ctx, "fb", nil); err != nil {
		t.Fatal(err)
	}
	if h, _ := r.AttestBucketPassHash(ctx, "fb"); h != nil {
		t.Fatalf("revoke kept the pass hash: %x", h)
	}
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "fb2", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.MoveAttestInstall(ctx, "fb2", "old"); err != nil {
		t.Fatal(err)
	}
	if in, _ := r.AttestInstall(ctx, "fb2"); in.BucketID != "old" || !in.Granted {
		t.Fatalf("moved install: %+v", in)
	}
	if err := r.MoveAttestInstall(ctx, "fb2", "nope"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("move to an unknown bucket: %v", err)
	}
	if err := goose.DownTo(d.DB, "migrations", 31); err != nil {
		t.Fatal(err)
	}
	var keys string
	if err := d.QueryRowContext(ctx, `SELECT group_concat(key_id, ',') FROM (SELECT key_id FROM attest_installs ORDER BY key_id)`).Scan(&keys); err != nil || keys != "fb2,old" {
		t.Fatalf("installs after rollback: %q %v", keys, err)
	}
	var buckets int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM attest_buckets`).Scan(&buckets); err != nil || buckets != 1 {
		t.Fatalf("buckets after rollback: %d %v", buckets, err)
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
