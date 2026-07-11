package gojaspike

import (
	"runtime"
	"testing"
)

// BenchmarkVMMemory reports the approximate retained heap per warm VM.
//
// Method: warm one VM first (to exclude one-time module-source/regexp costs),
// then per outer iteration force a GC, snapshot HeapAlloc, allocate a fixed
// batch of VMs (held alive), force GC, snapshot again, and divide the delta by
// the batch size. A fixed batch (not b.N) bounds peak memory regardless of how
// long the framework runs the benchmark; the reported metric is the last
// sample. Signed int64 delta guards against uint underflow.
//
// Caveat (feeds docs findings): this is a noisy figure — it includes each VM's
// records-port struct and any goja lazy allocations, and GC timing/heap
// fragmentation add jitter. Treat it as an order-of-magnitude bytes/VM, not an
// exact footprint. VMs share one *sql.DB, so the DB itself is not counted.
func BenchmarkVMMemory(b *testing.B) {
	const batch = 100
	db := openBenchDB(b)

	if _, err := newVM(db, bpModulePath, "createBPDomain", fixedNowMs, fixedTZ); err != nil {
		b.Fatalf("warm newVM: %v", err)
	}

	var perVM float64
	for i := 0; i < b.N; i++ {
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)

		vms := make([]*vmHarness, batch)
		for j := range vms {
			h, err := newVM(db, bpModulePath, "createBPDomain", fixedNowMs, fixedTZ)
			if err != nil {
				b.Fatalf("newVM: %v", err)
			}
			vms[j] = h
		}

		runtime.GC()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)

		delta := int64(after.HeapAlloc) - int64(before.HeapAlloc)
		perVM = float64(delta) / float64(batch)

		runtime.KeepAlive(vms)
		vms = nil
	}
	b.ReportMetric(perVM, "heapbytes/vm")
}
