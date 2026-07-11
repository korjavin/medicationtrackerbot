package gojaspike

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"

	_ "modernc.org/sqlite" // pure-Go driver, matches internal/store/db
)

// bpModulePath is the unmodified web/domain module the benchmarks drive.
const bpModulePath = "../../web/domain/bp.js"

// benchCreateExpr is a single deterministic BP create (145/92 → Stage 2). genId
// uses Math.random() so each call inserts a fresh row — a realistic per-call
// write, not an overwrite.
const benchCreateExpr = `domain.create({ measured_at: '2026-05-30T10:00:00.000Z', systolic: 145, diastolic: 92 })`

// openBenchDB opens a fresh in-memory SQLite DB for a benchmark; setup fatal.
func openBenchDB(b *testing.B) *sql.DB {
	b.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		b.Fatalf("open db: %v", err)
	}
	b.Cleanup(func() { db.Close() })
	return db
}

// benchBPRepo opens a migrated in-memory native store with the same fixed
// clock/tz the JS side uses, so PerCallNative is a like-for-like comparison.
func benchBPRepo(b *testing.B) (*bp.Repo, context.Context) {
	b.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		b.Fatalf("open store db: %v", err)
	}
	b.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		b.Fatalf("migrate: %v", err)
	}
	r := bp.New(d, fixedTZLookup{tz: fixedTZ})
	r.SetClock(func() time.Time { return time.UnixMilli(fixedNowMs).UTC() })
	return r, context.Background()
}

// BenchmarkColdStart measures standing up a fresh VM: goja runtime + Intl shim +
// module source read/strip + eval + factory construct. The records DB is shared
// across iterations so the number isolates VM+module cost, not repeated DB open;
// module source is re-read from disk each iteration (a real cold start would
// cache it — a documented caveat, feeds the docs findings).
func BenchmarkColdStart(b *testing.B) {
	db := openBenchDB(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := newVM(db, bpModulePath, "createBPDomain", fixedNowMs, fixedTZ); err != nil {
			b.Fatalf("newVM: %v", err)
		}
	}
}

// BenchmarkPerCallGoja measures one create through a REUSED VM (the pooled/warm
// path): the amortized per-request latency once the VM is already built.
func BenchmarkPerCallGoja(b *testing.B) {
	db := openBenchDB(b)
	h, err := newVM(db, bpModulePath, "createBPDomain", fixedNowMs, fixedTZ)
	if err != nil {
		b.Fatalf("newVM: %v", err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := h.awaitCall(benchCreateExpr); err != nil {
			b.Fatalf("create: %v", err)
		}
	}
}

// BenchmarkPerCallNative measures the equivalent native store CreateReading, so
// the goja per-call overhead can be read directly against the Go baseline.
func BenchmarkPerCallNative(b *testing.B) {
	r, ctx := benchBPRepo(b)
	measured := time.UnixMilli(fixedNowMs).UTC()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := &bp.BloodPressure{
			UserID:     bpUserID,
			MeasuredAt: measured,
			Systolic:   145,
			Diastolic:  92,
		}
		if _, err := r.CreateReading(ctx, rec); err != nil {
			b.Fatalf("CreateReading: %v", err)
		}
	}
}

// BenchmarkPerRequestVM measures a full VM-per-request: build a fresh VM AND do
// one create per iteration. Contrast against BenchmarkPerCallGoja (reused VM) to
// see the cost of NOT pooling — the go/no-go input for a VM-pool decision in C6.
func BenchmarkPerRequestVM(b *testing.B) {
	db := openBenchDB(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h, err := newVM(db, bpModulePath, "createBPDomain", fixedNowMs, fixedTZ)
		if err != nil {
			b.Fatalf("newVM: %v", err)
		}
		if _, err := h.awaitCall(benchCreateExpr); err != nil {
			b.Fatalf("create: %v", err)
		}
	}
}
