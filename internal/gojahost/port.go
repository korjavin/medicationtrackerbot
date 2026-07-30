package gojahost

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dop251/goja"
)

// recordsSchema is the generic record table the port reads/writes. It mirrors
// the cloud-sync record model that web/domain/*.js were written against (the
// browser's encrypted IndexedDB store keys records by (type, id) with an opaque
// JSON body). Backing the server-side host with the SAME generic model — rather
// than the typed per-domain store tables (blood_pressure_readings, weight_logs,
// ...) — is deliberate: the JS modules mint STRING record ids ("bp_<ms>_<rand>")
// and round-trip them through list/remove, which cannot map onto the typed
// tables' INTEGER autoincrement PKs without a per-domain id-translation adapter.
// That typed-table adapter is the documented C6 follow-up (docs/cloud-mode.md);
// the host here is wired to a REAL internal/store/db-opened database, just to
// this generic table within it.
const recordsSchema = `CREATE TABLE IF NOT EXISTS gojahost_records (
	type TEXT NOT NULL,
	id   TEXT NOT NULL,
	data JSON NOT NULL,
	PRIMARY KEY (type, id)
);`

// RecordsPort exposes list/listRange/put/del to a goja VM over a *sql.DB. Each
// method returns a real, already-settled *goja.Promise (built via vm.NewPromise)
// so `await records.list(t)` in the JS domain resolves deterministically — the
// SQLite work is synchronous, so the promise is Fulfilled/Rejected before the
// FunctionCall returns. Every DB/JSON error becomes a promise rejection.
type RecordsPort struct {
	db *sql.DB
	vm *goja.Runtime
}

// NewRecordsPort creates the port and ensures the backing table exists.
func NewRecordsPort(db *sql.DB, vm *goja.Runtime) (*RecordsPort, error) {
	if _, err := db.Exec(recordsSchema); err != nil {
		return nil, fmt.Errorf("create records table: %w", err)
	}
	return &RecordsPort{db: db, vm: vm}, nil
}

// Bind installs list/listRange/put/del on the given records object.
func (rp *RecordsPort) Bind(records *goja.Object) error {
	for name, fn := range map[string]func(goja.FunctionCall) goja.Value{
		"list":      rp.list,
		"listRange": rp.listRange,
		"put":       rp.put,
		"del":       rp.del,
	} {
		if err := records.Set(name, fn); err != nil {
			return fmt.Errorf("bind records.%s: %w", name, err)
		}
	}
	return nil
}

// settle builds a promise, runs fn, and resolves with fn's value or rejects
// with its error. Because fn is synchronous the promise is settled on return.
func (rp *RecordsPort) settle(fn func() (interface{}, error)) goja.Value {
	promise, resolve, reject := rp.vm.NewPromise()
	v, err := fn()
	if err != nil {
		reject(rp.vm.ToValue(err.Error()))
	} else {
		resolve(rp.vm.ToValue(v))
	}
	return rp.vm.ToValue(promise)
}

// queryRows runs a records query and decodes each JSON body into a map.
func (rp *RecordsPort) queryRows(query string, args ...interface{}) ([]interface{}, error) {
	rows, err := rp.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []interface{}{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var rec map[string]interface{}
		if err := json.Unmarshal([]byte(data), &rec); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// list(type) → Promise<array of record objects>.
func (rp *RecordsPort) list(call goja.FunctionCall) goja.Value {
	recType := call.Argument(0).String()
	return rp.settle(func() (interface{}, error) {
		recs, err := rp.queryRows("SELECT data FROM gojahost_records WHERE type = ?", recType)
		if err != nil {
			return nil, fmt.Errorf("list %q: %w", recType, err)
		}
		return recs, nil
	})
}

// listRange(type, fromId, toId) → Promise<array>. Used by vitals.js for the
// day-keyed HR/SpO2/stress streams whose ids sort lexicographically by day.
func (rp *RecordsPort) listRange(call goja.FunctionCall) goja.Value {
	recType := call.Argument(0).String()
	fromID := call.Argument(1).String()
	toID := call.Argument(2).String()
	return rp.settle(func() (interface{}, error) {
		recs, err := rp.queryRows(
			"SELECT data FROM gojahost_records WHERE type = ? AND id >= ? AND id <= ?",
			recType, fromID, toID)
		if err != nil {
			return nil, fmt.Errorf("listRange %q [%q..%q]: %w", recType, fromID, toID, err)
		}
		return recs, nil
	})
}

// put(type, record) → Promise. record.recordId is the row id.
func (rp *RecordsPort) put(call goja.FunctionCall) goja.Value {
	recType := call.Argument(0).String()
	exported := call.Argument(1).Export()
	return rp.settle(func() (interface{}, error) {
		rec, ok := exported.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("put %q: record is not an object", recType)
		}
		id, ok := rec["recordId"].(string)
		if !ok || id == "" {
			return nil, fmt.Errorf("put %q: record.recordId missing or empty", recType)
		}
		data, err := json.Marshal(rec)
		if err != nil {
			return nil, fmt.Errorf("put %q marshal: %w", recType, err)
		}
		_, err = rp.db.Exec(
			"INSERT INTO gojahost_records (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data",
			recType, id, string(data))
		if err != nil {
			return nil, fmt.Errorf("put %q: %w", recType, err)
		}
		return goja.Undefined(), nil
	})
}

// del(type, id) → Promise.
func (rp *RecordsPort) del(call goja.FunctionCall) goja.Value {
	recType := call.Argument(0).String()
	id := call.Argument(1).String()
	return rp.settle(func() (interface{}, error) {
		if _, err := rp.db.Exec("DELETE FROM gojahost_records WHERE type = ? AND id = ?", recType, id); err != nil {
			return nil, fmt.Errorf("del %q/%q: %w", recType, id, err)
		}
		return goja.Undefined(), nil
	})
}

// wallParts backs the Intl shim: it returns the wall-clock components of an
// instant (ms epoch) in the given IANA zone, using Go's tz database.
func wallParts(ms int64, tz string) map[string]int {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		// Surface as a JS exception via the caller's runtime panic convention.
		panic("wallParts: load location " + tz + ": " + err.Error())
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
}
