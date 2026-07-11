package gojaspike

import (
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/dop251/goja"
)

// exportPrefix strips the leading `export ` keyword at the start of a line so
// `export function createBPDomain` / `export const calculateBPCategory` become
// plain globals. goja has no native ESM loader; this transpile-free transform
// is the documented load caveat (docs/cloud-mode.md → Goja spike). web/domain/
// *.js are NOT modified — the strip happens only on the in-memory copy here.
var exportPrefix = regexp.MustCompile(`(?m)^export `)

// loadModule reads web/domain/<x>.js and returns it with the ESM `export `
// prefixes stripped. Read errors are surfaced, never ignored.
func loadModule(path string) (string, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read module %q: %w", path, err)
	}
	return exportPrefix.ReplaceAllString(string(src), ""), nil
}

// injectIntlShim installs a minimal Intl.DateTimeFormat over the runtime.
//
// goja has NO Intl at all (confirmed: `Intl is not defined`). bp.js/weight.js
// use Intl only in their day-boundary math — `Intl.DateTimeFormat(locale,
// {timeZone, ...}).formatToParts(date)` to read a timestamp's wall-clock
// Y/M/D/H/M/S in a given IANA zone. We back that single primitive with Go's
// time package — the SAME tz database the native store's truncateToDay uses —
// so both sides resolve identical offsets and the JS day-weighting math runs
// unmodified. This is a documented spike caveat (docs/cloud-mode.md → Goja
// spike): not a real Intl, just the one capability the domain modules need.
// web/domain/*.js are NOT touched — the shim lives only in the VM.
func injectIntlShim(vm *goja.Runtime) error {
	if err := vm.Set("__wallParts", func(ms int64, tz string) map[string]int {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			panic(vm.ToValue("wallParts: load location " + tz + ": " + err.Error()))
		}
		t := time.UnixMilli(ms).In(loc)
		return map[string]int{
			"year":   t.Year(),
			"month":  int(t.Month()),
			"day":    t.Day(),
			"hour":   t.Hour(),
			"minute": t.Minute(),
			"second": t.Second(),
		}
	}); err != nil {
		return fmt.Errorf("set __wallParts: %w", err)
	}
	const shim = `globalThis.Intl = {
  DateTimeFormat: function (_locale, opts) {
    var tz = opts.timeZone;
    return {
      formatToParts: function (date) {
        var p = __wallParts(date.getTime(), tz);
        return [
          { type: 'year', value: String(p.year) },
          { type: 'month', value: String(p.month) },
          { type: 'day', value: String(p.day) },
          { type: 'hour', value: String(p.hour) },
          { type: 'minute', value: String(p.minute) },
          { type: 'second', value: String(p.second) },
        ];
      },
    };
  },
};`
	if _, err := vm.RunString(shim); err != nil {
		return fmt.Errorf("install Intl shim: %w", err)
	}
	return nil
}

// vmHarness holds a runtime with a single domain module loaded and its factory
// invoked, so tests can drive `domain.create(...)` etc. through awaitCall.
type vmHarness struct {
	vm *goja.Runtime
}

// newVM loads the module at path, injects the records/now/timeZone ports, and
// constructs `const domain = <factoryName>({records, now, timeZone})`. Every
// setup error is checked and returned — nothing is silently dropped.
func newVM(db *sql.DB, path, factoryName string, nowMs int64, tz string) (*vmHarness, error) {
	vm := goja.New()

	if err := injectIntlShim(vm); err != nil {
		return nil, err
	}

	port, err := NewRecordsPort(db, vm)
	if err != nil {
		return nil, err
	}

	src, err := loadModule(path)
	if err != nil {
		return nil, err
	}
	if _, err := vm.RunString(src); err != nil {
		return nil, fmt.Errorf("eval module %q: %w", path, err)
	}

	records := vm.NewObject()
	if err := port.Bind(records); err != nil {
		return nil, fmt.Errorf("bind records port: %w", err)
	}
	if err := vm.Set("__records", records); err != nil {
		return nil, fmt.Errorf("set __records: %w", err)
	}
	if err := vm.Set("__now", func() int64 { return nowMs }); err != nil {
		return nil, fmt.Errorf("set __now: %w", err)
	}
	if err := vm.Set("__timeZone", tz); err != nil {
		return nil, fmt.Errorf("set __timeZone: %w", err)
	}

	construct := fmt.Sprintf(
		"const domain = %s({ records: __records, now: __now, timeZone: __timeZone });",
		factoryName)
	if _, err := vm.RunString(construct); err != nil {
		return nil, fmt.Errorf("construct domain via %s: %w", factoryName, err)
	}

	return &vmHarness{vm: vm}, nil
}

// awaitCall runs jsExpr (which must evaluate to a Promise), then reads its
// settled state. This is the single deterministic path all parity tests use:
// goja runs enqueued promise-reaction jobs as the top-level RunString call
// unwinds, and the SQLite records port settles synchronously, so the returned
// promise is already Fulfilled/Rejected — never Pending. We assert that rather
// than assume it: Pending is a hard error (would mean a job never ran).
func (h *vmHarness) awaitCall(jsExpr string) (goja.Value, error) {
	v, err := h.vm.RunString(jsExpr)
	if err != nil {
		return nil, fmt.Errorf("run %q: %w", jsExpr, err)
	}
	promise, ok := v.Export().(*goja.Promise)
	if !ok {
		return nil, fmt.Errorf("run %q: result is not a Promise (got %T)", jsExpr, v.Export())
	}
	switch promise.State() {
	case goja.PromiseStateFulfilled:
		return promise.Result(), nil
	case goja.PromiseStateRejected:
		return nil, fmt.Errorf("run %q: promise rejected: %v", jsExpr, promise.Result())
	default: // PromiseStatePending
		return nil, fmt.Errorf("run %q: promise did not settle (still Pending) — microtask drain assumption broke", jsExpr)
	}
}
