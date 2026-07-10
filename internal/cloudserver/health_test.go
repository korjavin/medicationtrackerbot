package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// bd med-d5t.7 — /healthz returned "ok" unconditionally, so a cloud.db that was
// locked, corrupt, or on a full disk still reported healthy while every request
// failed. /readyz reads the database instead of asserting it is alive.
func TestReadyz(t *testing.T) {
	newDB := func(t *testing.T) *storedb.DB {
		t.Helper()
		d, err := storedb.Open(":memory:")
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		t.Cleanup(func() { d.Close() })
		if _, err := d.Exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY)`); err != nil {
			t.Fatalf("create table: %v", err)
		}
		return d
	}

	get := func(t *testing.T, h http.HandlerFunc) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		return rec
	}

	t.Run("ready when the database answers", func(t *testing.T) {
		rec := get(t, ReadyzHandler(newDB(t), "build-abc"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body %q", rec.Code, rec.Body.String())
		}
		var body readyResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if body.Status != "ready" {
			t.Errorf("status = %q, want ready", body.Status)
		}
		if body.BuildID != "build-abc" {
			t.Errorf("build = %q, want build-abc", body.BuildID)
		}
	})

	// The whole point of the bead: an unreachable database must not report healthy.
	t.Run("unready when the database is unreachable", func(t *testing.T) {
		d := newDB(t)
		d.Close()

		rec := get(t, ReadyzHandler(d, "build-abc"))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
		var body readyResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if body.Status != "unready" {
			t.Errorf("status = %q, want unready", body.Status)
		}
	})

	// A Ping would pass here; only a real read of a real table catches it.
	t.Run("unready when the schema is missing", func(t *testing.T) {
		d, err := storedb.Open(":memory:")
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer d.Close()

		if rec := get(t, ReadyzHandler(d, "")); rec.Code != http.StatusServiceUnavailable {
			t.Errorf("status = %d, want 503 for a database with no accounts table", rec.Code)
		}
	})

	// Unauthenticated endpoint: it must not tell a passer-by how many friends
	// are on this box, nor leak a filesystem path from the driver's error.
	t.Run("reveals neither the account count nor the underlying error", func(t *testing.T) {
		d := newDB(t)
		if _, err := d.Exec(`INSERT INTO accounts (id) VALUES ('a'), ('b'), ('c')`); err != nil {
			t.Fatalf("insert: %v", err)
		}
		if body := get(t, ReadyzHandler(d, "b")).Body.String(); strings.Contains(body, "3") {
			t.Errorf("readyz body %q leaks the account count", body)
		}

		d.Close()
		body := get(t, ReadyzHandler(d, "b")).Body.String()
		if strings.Contains(body, "sql:") || strings.Contains(body, "database is closed") {
			t.Errorf("readyz body %q leaks the driver error", body)
		}
	})
}
