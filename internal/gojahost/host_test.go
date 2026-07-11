package gojahost

import (
	"database/sql"
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"

	_ "modernc.org/sqlite" // pure-Go driver, matches internal/store/db
)

// fixedNowMs / fixedTZ are the deterministic clock+zone all host tests share.
const (
	fixedNowMs int64  = 1782000000000 // 2026-06-21T00:00:00Z — arbitrary but fixed
	fixedTZ    string = "America/New_York"
)

// newRealStoreDB opens a database through the REAL internal/store/db layer
// (busy timeout, migrations runner) and applies the full store schema, so the
// host runs against the actual store DB rather than a bare sql.Open — the
// records table coexists with the real domain tables. Returns the underlying
// *sql.DB the host takes.
func newRealStoreDB(t testing.TB) *sql.DB {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open store db: %v", err)
	}
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d.DB
}

// fixedNow returns the shared fixed clock.
func fixedNow() int64 { return fixedNowMs }

// newTestHost builds a host over a real-store DB with the fixed clock/tz.
func newTestHost(t testing.TB) *Host {
	t.Helper()
	h, err := New(newRealStoreDB(t), fixedNow, fixedTZ)
	if err != nil {
		t.Fatalf("New host: %v", err)
	}
	return h
}

// TestAllModulesLinkAndConstruct proves the production loader's core claim:
// EVERY web/domain module — including the ones with cross-module imports and
// colliding top-level declarations — links and, if it exposes a factory,
// constructs into a live domain inside a pooled VM. A regression here (a new
// import edge, a renamed factory, an Intl/port gap) fails loudly at host build.
func TestAllModulesLinkAndConstruct(t *testing.T) {
	// New already warms one VM (constructing every factory) and errors on any
	// link/construct failure; reaching here means all modules loaded.
	h := newTestHost(t)

	// Assert each constructed domain is actually present and is an object with
	// callable methods (not undefined), by borrowing a VM and probing __domains.
	v, err := h.borrowVM()
	if err != nil {
		t.Fatalf("borrowVM: %v", err)
	}
	defer h.releaseVM(v)

	for _, key := range Domains() {
		res, err := v.rt.RunString("typeof __domains." + key)
		if err != nil {
			t.Fatalf("probe __domains.%s: %v", key, err)
		}
		if got := res.String(); got != "object" {
			t.Errorf("__domains.%s is %q, want a constructed object", key, got)
		}
	}

	// Pure-function modules expose their exports via __exports.
	for _, probe := range []struct{ expr, want string }{
		{"typeof __exports.medschedule.planDoses", "function"},
		{"typeof __exports.tgcommand.parseCommand", "function"},
		{"typeof __exports.vault.recordsToVault", "function"},
	} {
		res, err := v.rt.RunString(probe.expr)
		if err != nil {
			t.Fatalf("probe %q: %v", probe.expr, err)
		}
		if got := res.String(); got != probe.want {
			t.Errorf("%s = %q, want %q", probe.expr, got, probe.want)
		}
	}
}

// TestPoolReusesWarmVMs proves the pool hands back a warm VM (not a fresh one)
// on the common path: after a borrow/release cycle, the next borrow returns the
// SAME runtime instance. This is the property the benchmarks quantify.
func TestPoolReusesWarmVMs(t *testing.T) {
	h := newTestHost(t)

	v1, err := h.borrowVM()
	if err != nil {
		t.Fatalf("borrow 1: %v", err)
	}
	h.releaseVM(v1)

	v2, err := h.borrowVM()
	if err != nil {
		t.Fatalf("borrow 2: %v", err)
	}
	h.releaseVM(v2)

	if v1 != v2 {
		t.Errorf("pool did not reuse the warm VM: %p vs %p", v1, v2)
	}
}

// TestCallDrainsDeterministically proves a domain method's promise is Fulfilled
// once RunString unwinds (never Pending), so Call's synchronous read is sound.
func TestCallDrainsDeterministically(t *testing.T) {
	h := newTestHost(t)

	got, err := h.Call("bp", "create",
		`{ measured_at: '2026-05-30T10:00:00.000Z', systolic: 145, diastolic: 92 }`)
	if err != nil {
		t.Fatalf("Call bp.create: %v", err)
	}
	resp, ok := got.Export().(map[string]interface{})
	if !ok {
		t.Fatalf("bp.create result is not an object: %T", got.Export())
	}
	if resp["category"] != "High BP Stage 2" {
		t.Fatalf("category = %v, want High BP Stage 2 — JS module did not run to completion", resp["category"])
	}
}
