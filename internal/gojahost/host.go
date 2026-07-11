// Package gojahost is the production server-side host for the runtime-agnostic
// JS domain layer in web/domain/*.js. It runs those modules — UNMODIFIED —
// inside the Go binary via goja (pure Go, CGO-free), backed by a SQLite records
// port over the real internal/store database, and reuses warm VMs from a pool
// so per-call latency stays near the ~38µs warm number the med-07y.1 spike
// measured instead of the ~10× cost of a fresh VM per request.
//
// This is the C6 unification foundation (med-07y.2): additive infrastructure
// only — nothing in the request-serving path is wired to it yet (that is the
// med-07y.3 shadow-mirror step). It supersedes the throwaway internal/gojaspike
// package, which proved feasibility for bp+weight; this host loads ALL domain
// modules through a real ESM linker (see loader.go) and pools VMs.
//
// Concurrency: a *goja.Runtime is not safe for concurrent use. Each pooled VM
// is used by one goroutine at a time (sync.Pool hands out exclusive ownership);
// the shared *sql.DB behind the records port is the only cross-VM state and is
// itself concurrency-safe.
package gojahost

import (
	"database/sql"
	"fmt"
	"sync"

	"github.com/dop251/goja"
)

// Host owns the linked JS program, the injected ports, and a pool of warm VMs.
// Construct one per database/timezone with New, then serve calls via Call.
type Host struct {
	db     *sql.DB
	nowMs  func() int64
	tz     string
	linked string // the linked module program (built once, reused per VM)

	pool sync.Pool
}

// New builds a host over db (which must be an internal/store/db-opened database
// — the records table is created lazily in it), a now() clock in ms epoch, and
// a fixed IANA timezone. It links the module program once and warms a single VM
// eagerly to surface any load/construct error at construction time rather than
// on the first Call.
//
// tz is fixed for the host's lifetime because the JS factories capture timeZone
// by value at construct time (createBPDomain({ timeZone })), so a different zone
// needs a differently-constructed VM. now() stays dynamic — it is injected as a
// callback, so a pooled VM reports the current time on every call.
func New(db *sql.DB, nowMs func() int64, tz string) (*Host, error) {
	if db == nil {
		return nil, fmt.Errorf("gojahost: nil db")
	}
	if nowMs == nil {
		return nil, fmt.Errorf("gojahost: nil now function")
	}
	linked, _, err := buildLinkedSource()
	if err != nil {
		return nil, fmt.Errorf("gojahost: link modules: %w", err)
	}
	h := &Host{db: db, nowMs: nowMs, tz: tz, linked: linked}
	h.pool.New = func() interface{} {
		vm, err := h.buildVM()
		if err != nil {
			// sync.Pool.New cannot return an error; stash it so borrowVM can
			// surface it instead of handing out a broken VM.
			return brokenVM{err: err}
		}
		return vm
	}

	// Warm one VM eagerly to fail fast on a link/construct error.
	warm, err := h.buildVM()
	if err != nil {
		return nil, fmt.Errorf("gojahost: warm VM: %w", err)
	}
	h.pool.Put(warm)
	return h, nil
}

// vm is one warm runtime: all modules linked, all domains constructed.
type vm struct {
	rt *goja.Runtime
}

// brokenVM carries a build error out of sync.Pool.New (which cannot itself
// return one) so borrowVM can report it.
type brokenVM struct{ err error }

// noopPorts installs the ports a few factories require beyond records/now/tz:
// foodDb (food-database lookup), rxnorm (drug interactions), aiClient (LLM meal
// parsing). Server-side these will be real Go-backed ports in med-07y.3; for the
// additive host + parity harness they are inert so every factory constructs.
// Their absence only affects the methods that call them (which the parity tests
// do not drive for those domains — see the deferral notes in the package tests).
const noopPortsShim = `
globalThis.__foodDb = {
  async searchByName() { return []; },
  async searchByBarcode() { return null; },
};
globalThis.__rxnorm = {
  async searchRxNorm() { return { rxcui: '', normalizedName: '' }; },
  async checkInteractions() { return []; },
};
globalThis.__aiClient = {
  async parseMealFromDescription() { return { items: [] }; },
  async parseMealFromImage() { return { items: [] }; },
};
globalThis.__domains = {};
`

// buildVM stands up one runtime: Intl shim, records port, injected now/tz/noop
// ports, the linked module program, then constructs every domain into
// __domains. Every setup error is checked and returned.
func (h *Host) buildVM() (*vm, error) {
	rt := goja.New()

	if err := injectIntlShim(rt); err != nil {
		return nil, err
	}

	port, err := NewRecordsPort(h.db, rt)
	if err != nil {
		return nil, err
	}
	records := rt.NewObject()
	if err := port.Bind(records); err != nil {
		return nil, fmt.Errorf("bind records port: %w", err)
	}
	if err := rt.Set("__records", records); err != nil {
		return nil, fmt.Errorf("set __records: %w", err)
	}
	if err := rt.Set("__now", func() int64 { return h.nowMs() }); err != nil {
		return nil, fmt.Errorf("set __now: %w", err)
	}
	if err := rt.Set("__timeZone", h.tz); err != nil {
		return nil, fmt.Errorf("set __timeZone: %w", err)
	}
	if _, err := rt.RunString(noopPortsShim); err != nil {
		return nil, fmt.Errorf("install noop ports: %w", err)
	}

	if _, err := rt.RunString(h.linked); err != nil {
		return nil, fmt.Errorf("eval linked modules: %w", err)
	}

	// Construct each domain factory into __domains, in dependency order (food
	// before foodai). A construct failure is a hard error — the host must not
	// hand out a VM with a missing domain.
	byKey := map[string]moduleSpec{}
	for _, m := range modules {
		byKey[m.key] = m
	}
	for _, key := range constructOrder {
		spec := byKey[key]
		if spec.construct == "" {
			continue
		}
		if _, err := rt.RunString(fmt.Sprintf("__domains.%s = %s;", key, spec.construct)); err != nil {
			return nil, fmt.Errorf("construct domain %q: %w", key, err)
		}
	}

	return &vm{rt: rt}, nil
}

// borrowVM takes a warm VM from the pool (or builds one), surfacing a stashed
// build error. The caller MUST return it via releaseVM.
func (h *Host) borrowVM() (*vm, error) {
	got := h.pool.Get()
	if b, ok := got.(brokenVM); ok {
		return nil, b.err
	}
	return got.(*vm), nil
}

// releaseVM returns a VM to the pool for reuse.
func (h *Host) releaseVM(v *vm) { h.pool.Put(v) }

// Call invokes __domains.<domain>.<method>(<args...>) and returns the settled
// result. argsJSON is a comma-free list of already-encoded JS argument
// expressions (e.g. `{"systolic":120}` or `{"systolic":120}, {"recordId":"x"}`).
// The returned promise is drained deterministically (see awaitCall): a promise
// that does not settle is a hard error, never a silent null.
func (h *Host) Call(domain, method, argsJSON string) (goja.Value, error) {
	v, err := h.borrowVM()
	if err != nil {
		return nil, err
	}
	defer h.releaseVM(v)
	expr := fmt.Sprintf("__domains.%s.%s(%s)", domain, method, argsJSON)
	return awaitCall(v.rt, expr)
}

// Domains returns the domain keys the host constructs (those with a factory),
// so callers/tests can enumerate what is loaded.
func Domains() []string {
	out := make([]string, 0, len(constructOrder))
	out = append(out, constructOrder...)
	return out
}

// awaitCall runs jsExpr (which must evaluate to a Promise) on rt, then reads its
// settled state. goja runs enqueued promise-reaction jobs as the top-level
// RunString call unwinds, and the SQLite records port settles synchronously, so
// the returned promise is already Fulfilled/Rejected — never Pending. We assert
// that rather than assume it: Pending is a hard error (a job never ran).
func awaitCall(rt *goja.Runtime, jsExpr string) (goja.Value, error) {
	res, err := rt.RunString(jsExpr)
	if err != nil {
		return nil, fmt.Errorf("run %q: %w", jsExpr, err)
	}
	promise, ok := res.Export().(*goja.Promise)
	if !ok {
		return nil, fmt.Errorf("run %q: result is not a Promise (got %T)", jsExpr, res.Export())
	}
	switch promise.State() {
	case goja.PromiseStateFulfilled:
		return promise.Result(), nil
	case goja.PromiseStateRejected:
		return nil, fmt.Errorf("run %q: promise rejected: %v", jsExpr, promise.Result())
	default:
		return nil, fmt.Errorf("run %q: promise did not settle (still Pending) — microtask drain assumption broke", jsExpr)
	}
}
