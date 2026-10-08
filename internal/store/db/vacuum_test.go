package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func pragmaInt(t *testing.T, q interface {
	QueryRow(string, ...any) *sql.Row
}, name string) int64 {
	t.Helper()
	var v int64
	if err := q.QueryRow("PRAGMA " + name).Scan(&v); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	return v
}

func churn(t *testing.T, d interface {
	Exec(string, ...any) (sql.Result, error)
}, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := d.Exec(`INSERT INTO t VALUES (zeroblob(4000))`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.Exec(`DELETE FROM t`); err != nil {
		t.Fatal(err)
	}
}

func TestOpen_FreshFileIsIncrementalAutoVacuum(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if got := pragmaInt(t, d, "auto_vacuum"); got != 2 {
		t.Fatalf("auto_vacuum = %d, want 2 (INCREMENTAL)", got)
	}
}

// An existing auto_vacuum=NONE file (prod cloud.db before med-tvfn) is
// converted once by Open; the second Open is a no-op.
func TestOpen_ConvertsLegacyFileOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE t (b BLOB)`); err != nil {
		t.Fatal(err)
	}
	churn(t, raw, 500)
	if got := pragmaInt(t, raw, "auto_vacuum"); got != 0 {
		t.Fatalf("fixture auto_vacuum = %d, want 0", got)
	}
	if got := pragmaInt(t, raw, "freelist_count"); got < 400 {
		t.Fatalf("fixture freelist_count = %d, want a bloated freelist", got)
	}
	_ = raw.Close()

	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := pragmaInt(t, d, "auto_vacuum"); got != 2 {
		t.Fatalf("auto_vacuum after first Open = %d, want 2", got)
	}
	if got := pragmaInt(t, d, "freelist_count"); got != 0 {
		t.Fatalf("freelist_count after conversion = %d, want 0", got)
	}
	// Plant free pages; the next Open must leave them (a VACUUM would not).
	churn(t, d, 50)
	_ = d.Close()

	d, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if got := pragmaInt(t, d, "freelist_count"); got == 0 {
		t.Fatal("second Open reclaimed free pages — it ran VACUUM again, want a no-op")
	}
}
