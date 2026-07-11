// Package gojaspike is a throwaway feasibility spike (med-07y.1): it runs the
// pure-JS domain layer in web/domain/*.js server-side inside the Go binary via
// goja, backed by a SQLite records port, and asserts value-exact parity against
// the native Go domain in internal/store. No production wiring — see
// docs/cloud-mode.md "Goja spike".
package gojaspike

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/dop251/goja"
)

// records is the SQLite-backed table every port method reads/writes. Matches
// the contract createBPDomain/createWeightDomain expect from `records`.
const recordsSchema = `CREATE TABLE IF NOT EXISTS records (
	type TEXT NOT NULL,
	id   TEXT NOT NULL,
	data JSON NOT NULL,
	PRIMARY KEY (type, id)
);`

// RecordsPort exposes list/put/del to a goja VM over a *sql.DB. Each method
// returns a real, already-settled *goja.Promise (built via vm.NewPromise) so
// `await records.list(t)` in the JS domain resolves deterministically — the
// SQLite work is synchronous, so the promise is Fulfilled/Rejected before the
// FunctionCall returns. Every DB/JSON error becomes a promise rejection (never
// silently dropped).
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

// Bind installs list/put/del on the given records object.
func (rp *RecordsPort) Bind(records *goja.Object) error {
	if err := records.Set("list", rp.list); err != nil {
		return err
	}
	if err := records.Set("put", rp.put); err != nil {
		return err
	}
	if err := records.Set("del", rp.del); err != nil {
		return err
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

// list(type) → Promise<array of record objects>.
func (rp *RecordsPort) list(call goja.FunctionCall) goja.Value {
	recType := call.Argument(0).String()
	return rp.settle(func() (interface{}, error) {
		rows, err := rp.db.Query("SELECT data FROM records WHERE type = ?", recType)
		if err != nil {
			return nil, fmt.Errorf("list %q: %w", recType, err)
		}
		defer rows.Close()

		out := []interface{}{}
		for rows.Next() {
			var data string
			if err := rows.Scan(&data); err != nil {
				return nil, fmt.Errorf("list %q scan: %w", recType, err)
			}
			var rec map[string]interface{}
			if err := json.Unmarshal([]byte(data), &rec); err != nil {
				return nil, fmt.Errorf("list %q unmarshal: %w", recType, err)
			}
			out = append(out, rec)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("list %q rows: %w", recType, err)
		}
		return out, nil
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
			"INSERT INTO records (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data",
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
		if _, err := rp.db.Exec("DELETE FROM records WHERE type = ? AND id = ?", recType, id); err != nil {
			return nil, fmt.Errorf("del %q/%q: %w", recType, id, err)
		}
		return goja.Undefined(), nil
	})
}
