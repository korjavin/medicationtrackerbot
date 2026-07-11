package gojaspike

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite" // pure-Go driver, matches internal/store/db
)

// fixedNowMs / fixedTZ are the deterministic clock+zone all spike tests share.
const (
	fixedNowMs int64  = 1782000000000 // 2026-05-31T05:20:00Z — arbitrary but fixed
	fixedTZ    string = "America/New_York"
)

// openTestDB opens a fresh in-memory SQLite DB; every setup error is fatal.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// TestDrainIsDeterministic proves the core Task-2 assumption: a domain.create
// call's returned promise is Fulfilled (never Pending) once RunString unwinds,
// so awaitCall's synchronous read is sound. If goja ever stops draining its job
// queue on unwind, this fails loudly instead of silently returning null.
func TestDrainIsDeterministic(t *testing.T) {
	db := openTestDB(t)
	h, err := newVM(db, "../../web/domain/bp.js", "createBPDomain", fixedNowMs, fixedTZ)
	if err != nil {
		t.Fatalf("newVM: %v", err)
	}

	// awaitCall already errors on Rejected/Pending; a nil error means Fulfilled.
	got, err := h.awaitCall(`domain.create({ measured_at: '2026-05-30T10:00:00.000Z', systolic: 145, diastolic: 92 })`)
	if err != nil {
		t.Fatalf("create promise did not fulfill: %v", err)
	}

	resp, ok := got.Export().(map[string]interface{})
	if !ok {
		t.Fatalf("create result is not an object: %T", got.Export())
	}
	// Category must have been computed by the unmodified JS module (145/92 → Stage 2).
	if resp["category"] != "High BP Stage 2" {
		t.Fatalf("category = %v, want High BP Stage 2 — JS module did not run to completion", resp["category"])
	}
}
