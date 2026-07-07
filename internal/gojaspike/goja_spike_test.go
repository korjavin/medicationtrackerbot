package gojaspike

import (
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
	_ "modernc.org/sqlite"
)

func setupDB(t testing.TB) *sql.DB {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS records (
			type TEXT,
			id TEXT,
			data JSON,
			PRIMARY KEY (type, id)
		);
	`)
	if err != nil {
		t.Fatalf("failed to create table: %v", err)
	}
	return db
}

// RecordsPort provides the DB interface to the JS domain
type RecordsPort struct {
	db *sql.DB
	vm *goja.Runtime
}

func (rp *RecordsPort) put(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()
	recordObj := call.Argument(1).Export().(map[string]interface{})
	id, ok := recordObj["recordId"].(string)
	if !ok {
		panic("recordId missing")
	}

	dataBytes, _ := json.Marshal(recordObj)
	_, err := rp.db.Exec("INSERT INTO records (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data", rt, id, string(dataBytes))
	if err != nil {
		panic(err)
	}

	res, _ := rp.vm.RunString("Promise.resolve()")
	return res
}

func (rp *RecordsPort) list(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()

	rows, err := rp.db.Query("SELECT data FROM records WHERE type = ?", rt)
	if err != nil {
		panic(err)
	}
	defer rows.Close()

	var records []interface{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			panic(err)
		}
		var rec map[string]interface{}
		if err := json.Unmarshal([]byte(data), &rec); err != nil {
			panic(err)
		}
		records = append(records, rec)
	}

	// Create a JS array and wrap it in a promise
	rp.vm.Set("_tmpList", records)
	res, _ := rp.vm.RunString("Promise.resolve(_tmpList)")
	return res
}

func (rp *RecordsPort) del(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()
	id := call.Argument(1).String()

	_, err := rp.db.Exec("DELETE FROM records WHERE type = ? AND id = ?", rt, id)
	if err != nil {
		panic(err)
	}

	res, _ := rp.vm.RunString("Promise.resolve()")
	return res
}

func loadJS(t testing.TB) string {
	bpJSBytes, err := os.ReadFile("../../web/domain/bp.js")
	if err != nil {
		t.Fatalf("failed to read bp.js: %v", err)
	}

	code := string(bpJSBytes)
	code = strings.ReplaceAll(code, "export function", "function")
	code = strings.ReplaceAll(code, "export const", "const")
	return code
}

func setupVM(t testing.TB, code string, db *sql.DB) *goja.Runtime {
	vm := goja.New()

	_, err := vm.RunString(code)
	if err != nil {
		t.Fatalf("run js failed: %v", err)
	}

	rp := &RecordsPort{db: db, vm: vm}

	records := vm.NewObject()
	records.Set("put", rp.put)
	records.Set("list", rp.list)
	records.Set("del", rp.del)

	injection := vm.NewObject()
	injection.Set("records", records)
	injection.Set("now", func() int64 {
		return time.Now().UnixMilli()
	})
	injection.Set("timeZone", "America/New_York")

	vm.Set("injectionArgs", injection)

	_, err = vm.RunString(`
		const domain = createBPDomain(injectionArgs);

		function callCreateSync(input) {
			var done = false;
			var res = null;
			var err = null;
			domain.create(input).then(r => {
				res = r;
				done = true;
			}).catch(e => {
				err = e;
				done = true;
			});
			// Since we use native Go sync DB calls and mock Promises that resolve immediately in the port,
			// the microtasks might execute synchronously if we force them, or we can just return the promise.
			// Actually, Goja doesn't have an event loop by default, so Promise chains might not resolve unless we run them.
			return domain.create(input);
		}
	`)
	if err != nil {
		t.Fatalf("setup injection failed: %v", err)
	}

	return vm
}

func TestGojaBP(t *testing.T) {
	db := setupDB(t)
	defer db.Close()
	code := loadJS(t)
	vm := setupVM(t, code, db)

	// Since Goja Promises don't resolve automatically without an event loop loop,
	// let's use a simpler wrapper. Wait, the domain functions return async Promises.
	// We can use a small polyfill or just rely on a simple callback if we transpile, but we aren't transpiling async/await.
	// Oh, bp.js uses `async/await` which means it returns native Goja Promises!

	// Wait, if bp.js uses `async function`, Goja supports native Promises since recently.

	inputObj := vm.NewObject()
	inputObj.Set("measured_at", time.Now().Format(time.RFC3339))
	inputObj.Set("systolic", 125)
	inputObj.Set("diastolic", 85)
	vm.Set("inputObj", inputObj)

	val, err := vm.RunString(`
		var result = null;
		domain.create(inputObj).then(r => result = r);
		result;
	`)
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	t.Logf("Result: %v", val.Export())
}
