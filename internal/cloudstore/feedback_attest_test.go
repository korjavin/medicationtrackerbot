package cloudstore

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/pressly/goose/v3"
)

// Migration 031 (bd med-ta2n.19) on a database at 030 with queued and drained
// feedback: rows and ids survive unchanged, the FK is gone, UNIQUE and the
// drain index stay, drained ids are not reissued, and an install row fits.
func TestMigration031DropsFeedbackFK(t *testing.T) {
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
	if err := goose.UpTo(d.DB, "migrations", 30); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO accounts (id, subdomain, created_at_unix) VALUES ('acc-1', 'one', 1)`,
		`INSERT INTO feedback_queue (account_id, client_id, kind, app_version, ciphertext, created_at_unix) VALUES ('acc-1', 'c1', 'bug', '1.0', x'0102', 10)`,
		`INSERT INTO feedback_queue (account_id, client_id, kind, app_version, ciphertext, created_at_unix) VALUES ('acc-1', 'c2', 'idea', '1.1', x'03', 20)`,
		`DELETE FROM feedback_queue WHERE client_id = 'c2'`, // drained: id 2 must never come back
	} {
		if _, err := d.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	r, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	items, err := r.ListFeedback(ctx, 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("migrated rows: %+v %v", items, err)
	}
	if it := items[0]; it.ID != 1 || it.AccountID != "acc-1" || it.ClientID != "c1" || it.Kind != "bug" || it.AppVersion != "1.0" || string(it.Ciphertext) != "\x01\x02" || it.CreatedAt.Unix() != 10 {
		t.Fatalf("migrated row changed: %+v", it)
	}
	var fks int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_foreign_key_list('feedback_queue')`).Scan(&fks); err != nil || fks != 0 {
		t.Fatalf("feedback_queue FKs after 031: %d %v", fks, err)
	}
	var idx int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_queue_created'`).Scan(&idx); err != nil || idx != 1 {
		t.Fatalf("drain index: %d %v", idx, err)
	}
	now := time.Unix(30, 0)
	if _, err := r.AppendFeedback(ctx, AttestFeedbackAccount("key"), "c1", "bug", "2.0", []byte{9}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(ctx, `INSERT INTO feedback_queue (account_id, client_id, ciphertext, created_at_unix) VALUES ('acc-1', 'c1', x'00', 1)`); err == nil {
		t.Fatal("UNIQUE(account_id, client_id) lost")
	}
	items, _ = r.ListFeedback(ctx, 10)
	if len(items) != 2 || items[1].ID != 3 || items[1].AccountID != "attest:key" {
		t.Fatalf("after install append: %+v", items)
	}
	// Rollback keeps account rows and drops install rows (no accounts row).
	if err := goose.DownTo(d.DB, "migrations", 30); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM feedback_queue WHERE account_id = 'acc-1'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rolled back: %d %v", n, err)
	}
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_foreign_key_list('feedback_queue')`).Scan(&fks); err != nil || fks != 1 {
		t.Fatalf("FK not restored: %d %v", fks, err)
	}
}

// bd med-ta2n.19: the attested append advances the counter in the same
// transaction, keeps it spent when the cap refuses, and dedupes per install.
func TestAppendAttestFeedback(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	r := setupRepo(t)
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k1", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if q, err := r.AppendAttestFeedback(ctx, "k1", 1, "c1", "bug", "1.0", []byte{1}, now); !q || err != nil {
		t.Fatalf("first: %v %v", q, err)
	}
	if _, err := r.AppendAttestFeedback(ctx, "k1", 1, "c2", "bug", "1.0", []byte{1}, now); !errors.Is(err, ErrAttestCounter) {
		t.Fatalf("reused counter: %v", err)
	}
	if q, err := r.AppendAttestFeedback(ctx, "k1", 2, "c1", "bug", "1.0", []byte{2}, now); q || err != nil {
		t.Fatalf("retry: %v %v", q, err)
	}
	for i := 1; i < feedbackPerAccountCap; i++ {
		if _, err := r.AppendFeedback(ctx, AttestFeedbackAccount("k1"), "fill-"+strconv.Itoa(i), "", "", []byte{1}, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.AppendAttestFeedback(ctx, "k1", 3, "over", "bug", "1.0", []byte{1}, now); !errors.Is(err, ErrFeedbackQueueFull) {
		t.Fatalf("over cap: %v", err)
	}
	if in, _ := r.AttestInstall(ctx, "k1"); in.Counter != 3 {
		t.Fatalf("counter not spent on a refused append: %d", in.Counter)
	}
	// A second key in k1's bucket (pass rejoin / key rotation) shares the cap
	// and the client_id dedupe: no fresh allowance.
	if err := r.InsertAttestInstall(ctx, AttestInstall{KeyID: "k2", BucketID: "k1", PublicKey: []byte{1}, Env: "production", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendAttestFeedback(ctx, "k2", 1, "k2-new", "bug", "1.0", []byte{1}, now); !errors.Is(err, ErrFeedbackQueueFull) {
		t.Fatalf("joined key over the bucket cap: %v", err)
	}
	if q, err := r.AppendAttestFeedback(ctx, "k2", 2, "c1", "bug", "1.0", []byte{1}, now); q || err != nil {
		t.Fatalf("joined key retry of the bucket's c1: %v %v", q, err)
	}
}
