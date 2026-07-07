package gojaspike

import (
	"database/sql"
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

func loadJS(t testing.TB, path string) string {
	bpJSBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read %s: %v", path, err)
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

	rp := NewRecordsPort(db, vm)

	records := vm.NewObject()
	rp.Setup(records)

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
	code := loadJS(t, "../../web/domain/bp.js")
	vm := setupVM(t, code, db)

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
