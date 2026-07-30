package gojahost

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// benchCreateExpr is a single deterministic BP create (145/92 → Stage 2). The
// JS genId uses Math.random() so each call inserts a fresh row — a realistic
// per-call write, not an overwrite.
const benchCreateExpr = `{ measured_at: '2026-05-30T10:00:00.000Z', systolic: 145, diastolic: 92 }`

// benchBPRepo opens a migrated in-memory native store with the same fixed
// clock/tz the host uses, so NativeCreate is a like-for-like comparison.
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

// BenchmarkPooledCall measures one bp.create through the POOLED host: borrow a
// warm VM, run the create, return it. This is the production per-request path
// and should sit near the spike's warm ~38µs number — the pooling win.
func BenchmarkPooledCall(b *testing.B) {
	h, err := New(newRealStoreDB(b), fixedNow, fixedTZ)
	if err != nil {
		b.Fatalf("New host: %v", err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := h.Call("bp", "create", benchCreateExpr); err != nil {
			b.Fatalf("Call: %v", err)
		}
	}
}

// BenchmarkFreshVMPerCall measures the NON-pooled path: build a full production
// VM (all 15 modules linked, all 12 domains constructed) AND do one create per
// iteration. Contrast against BenchmarkPooledCall to see the cost of not
// pooling. This is heavier than the spike's single-module fresh VM because the
// production host loads the whole domain layer.
func BenchmarkFreshVMPerCall(b *testing.B) {
	h, err := New(newRealStoreDB(b), fixedNow, fixedTZ)
	if err != nil {
		b.Fatalf("New host: %v", err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v, err := h.buildVM()
		if err != nil {
			b.Fatalf("buildVM: %v", err)
		}
		if _, err := awaitCall(v.rt, "__domains.bp.create("+benchCreateExpr+")"); err != nil {
			b.Fatalf("create: %v", err)
		}
	}
}

// BenchmarkNativeCreate measures the equivalent native store CreateReading, so
// the goja per-call overhead can be read directly against the Go baseline.
func BenchmarkNativeCreate(b *testing.B) {
	r, ctx := benchBPRepo(b)
	measured := time.UnixMilli(fixedNowMs).UTC()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := &bp.BloodPressure{UserID: bpUserID, MeasuredAt: measured, Systolic: 145, Diastolic: 92}
		if _, err := r.CreateReading(ctx, rec); err != nil {
			b.Fatalf("CreateReading: %v", err)
		}
	}
}

// BenchmarkBuildVM isolates the cost of standing up one full production VM
// (Intl shim + records port + linked modules + 12 domain constructs). This is
// the amount of work pooling amortizes away.
func BenchmarkBuildVM(b *testing.B) {
	h, err := New(newRealStoreDB(b), fixedNow, fixedTZ)
	if err != nil {
		b.Fatalf("New host: %v", err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := h.buildVM(); err != nil {
			b.Fatalf("buildVM: %v", err)
		}
	}
}

// BenchmarkVMMemory reports the approximate retained heap per warm production
// VM. Method: warm one VM (exclude one-time module-link cost), then per outer
// iteration force GC, snapshot HeapAlloc, allocate a fixed batch of VMs (held
// alive), force GC, snapshot again, divide by batch size. Noisy — treat as an
// order-of-magnitude bytes/VM. VMs share one *sql.DB, so the DB is not counted.
func BenchmarkVMMemory(b *testing.B) {
	const batch = 50
	h, err := New(newRealStoreDB(b), fixedNow, fixedTZ)
	if err != nil {
		b.Fatalf("New host: %v", err)
	}
	if _, err := h.buildVM(); err != nil {
		b.Fatalf("warm buildVM: %v", err)
	}

	var perVM float64
	for i := 0; i < b.N; i++ {
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)

		vms := make([]*vm, batch)
		for j := range vms {
			v, err := h.buildVM()
			if err != nil {
				b.Fatalf("buildVM: %v", err)
			}
			vms[j] = v
		}

		runtime.GC()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)

		perVM = float64(int64(after.HeapAlloc)-int64(before.HeapAlloc)) / float64(batch)
		runtime.KeepAlive(vms)
	}
	b.ReportMetric(perVM, "heapbytes/vm")
}
