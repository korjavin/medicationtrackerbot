package cloudserver

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// buildNXKFixture writes a Mi Band backup.db with every stream populated
// (sleep, heart, spo2, stress, day, workout + GPS) and zips it into a .nxk so
// parseNXKToVitalsEvents exercises the real extract → parse path. GPS rows are
// present in the DB precisely so the test can assert they never reach the event.
func buildNXKFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "backup.db")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	ctx := context.Background()
	schema := `
		CREATE TABLE sleep (start INTEGER, end INTEGER, tz INTEGER, day TEXT,
			light INTEGER, deep INTEGER, rem INTEGER, awake INTEGER, total INTEGER,
			turnOver INTEGER, hrAvg INTEGER, spo2Avg INTEGER, userModified INTEGER, info TEXT);
		CREATE TABLE heart (dateTime INTEGER, tz INTEGER, value INTEGER, type INTEGER);
		CREATE TABLE spo2 (dateTime INTEGER, tz INTEGER, value INTEGER, type INTEGER);
		CREATE TABLE stress (dateTime INTEGER, tz INTEGER, value INTEGER, type INTEGER, info TEXT);
		CREATE TABLE day (day TEXT, steps INTEGER, calories INTEGER, distance INTEGER);
		CREATE TABLE workout (startDateTime INTEGER, endDateTime INTEGER, type INTEGER,
			distance REAL, steps INTEGER, calories INTEGER, heartAvg INTEGER, spo2Avg INTEGER,
			pause INTEGER, tz INTEGER);
		CREATE TABLE gps (dateTime INTEGER, latitude REAL, longitude REAL, altitude REAL, speed REAL, pause INTEGER);
	`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		t.Fatalf("schema: %v", err)
	}

	start := time.Now().UnixMilli()
	end := start + 8*3600*1000
	mustExec(t, db, `INSERT INTO sleep VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		start, end, 60, "2023-10-27", 100, 200, 50, 30, 380, 5, 60, 98, 0, "good sleep")
	mustExec(t, db, `INSERT INTO heart VALUES (?,?,?,?)`, start, 60, 75, 1)
	mustExec(t, db, `INSERT INTO spo2 VALUES (?,?,?,?)`, start, 60, 98, 1)
	mustExec(t, db, `INSERT INTO stress VALUES (?,?,?,?,?)`, start, 60, 45, 1, "stressful day")
	mustExec(t, db, `INSERT INTO day VALUES (?,?,?,?)`, "2023-10-27", 10000, 500, 7500)
	// type 3 = walking (outdoor), distance > 0 so it is imported.
	wStart := int64(4000000)
	wEnd := int64(4001000000)
	mustExec(t, db, `INSERT INTO workout VALUES (?,?,?,?,?,?,?,?,?,?)`,
		wStart, wEnd, 3, 3000.0, 3800, 250, 125, 0, 0, 60)
	// GPS point inside the workout window — must be dropped from the event.
	mustExec(t, db, `INSERT INTO gps VALUES (?,?,?,?,0,?)`, wStart+1000, 52.5, 13.4, 34.0, 0)
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	nxkPath := filepath.Join(dir, "export.nxk")
	f, err := os.Create(nxkPath)
	if err != nil {
		t.Fatalf("create nxk: %v", err)
	}
	zw := zip.NewWriter(f)
	entry, err := zw.Create("backup.db")
	if err != nil {
		t.Fatalf("zip entry: %v", err)
	}
	raw, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read db: %v", err)
	}
	if _, err := entry.Write(raw); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("nxk close: %v", err)
	}
	return nxkPath
}

func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func TestParseNXKToVitalsEvents(t *testing.T) {
	nxkPath := buildNXKFixture(t)

	events, err := parseNXKToVitalsEvents(nxkPath)
	if err != nil {
		t.Fatalf("parseNXKToVitalsEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0]

	if ev.Kind != inboxEventKindVitalsImport {
		t.Errorf("kind = %q, want %q", ev.Kind, inboxEventKindVitalsImport)
	}
	if ev.Import == "" {
		t.Error("import grouping id is empty")
	}
	if len(ev.Sleep) != 1 {
		t.Errorf("sleep = %d, want 1", len(ev.Sleep))
	}
	if len(ev.HR) != 1 {
		t.Errorf("hr = %d, want 1", len(ev.HR))
	}
	if len(ev.SpO2) != 1 {
		t.Errorf("spo2 = %d, want 1", len(ev.SpO2))
	}
	if len(ev.Stress) != 1 {
		t.Errorf("stress = %d, want 1", len(ev.Stress))
	}
	if len(ev.DayStats) != 1 {
		t.Errorf("daystats = %d, want 1", len(ev.DayStats))
	}
	if len(ev.Workouts) != 1 {
		t.Errorf("workouts = %d, want 1", len(ev.Workouts))
	}

	// GPS must be absent from the sealed payload entirely — assert on the wire
	// JSON so a stray field on any nested struct is caught, not just the top level.
	blob, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	for _, banned := range []string{"latitude", "longitude", "gps", "altitude", "13.4", "52.5"} {
		if strings.Contains(string(blob), banned) {
			t.Errorf("sealed payload leaks GPS token %q: %s", banned, blob)
		}
	}

	// Deterministic import id: re-parsing the same file yields the same grouping.
	again, err := parseNXKToVitalsEvents(nxkPath)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if again[0].Import != ev.Import {
		t.Errorf("import id not deterministic: %q vs %q", again[0].Import, ev.Import)
	}
}

// TestChildWebhook_NXKDocumentSealsVitalsToMailbox guards Task 3: a .nxk document
// sent to a linked cloud bot is downloaded + parsed server-side and its vitals
// streams sealed to the account's inbox — no GPS, no plaintext at rest — and the
// "Queued" ack is edited into a summary.
func TestChildWebhook_NXKDocumentSealsVitalsToMailbox(t *testing.T) {
	nxkPath := buildNXKFixture(t)
	nxkBytes, err := os.ReadFile(nxkPath)
	if err != nil {
		t.Fatalf("read nxk: %v", err)
	}

	tg := newRecordingTG(t)
	tg.mu.Lock()
	tg.mu.fileBody = nxkBytes
	tg.mu.Unlock()

	f := linkedBotTap(t, tg)
	privRaw := publishInboxKey(t, f.store, f.accountID)

	update := `{"update_id":4,"message":{"message_id":5,"chat":{"id":12345,"type":"private"},` +
		`"document":{"file_id":"NXKFILE","file_name":"export.nxk","file_size":` + strconv.Itoa(len(nxkBytes)) + `}}}`
	rec := postWebhook(t, f.top, f.childPath, f.secret, update)
	if rec.Code != http.StatusOK {
		t.Fatalf("nxk document webhook status = %d, body %q", rec.Code, rec.Body.String())
	}

	events, err := f.store.ListInboxEvents(t.Context(), f.accountID, 10)
	if err != nil {
		t.Fatalf("ListInboxEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("queued %d events, want 1", len(events))
	}
	// Nothing readable at rest: the kind must not appear in the ciphertext.
	if bytes.Contains(events[0].CT, []byte(inboxEventKindVitalsImport)) {
		t.Fatal("mailbox row contains plaintext kind")
	}

	opened, err := openInbox(privRaw, f.accountID, events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var got vitalsImportEvent
	if err := json.Unmarshal(opened, &got); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if got.Kind != inboxEventKindVitalsImport || got.Import == "" {
		t.Fatalf("sealed event kind/import = %q/%q", got.Kind, got.Import)
	}
	if len(got.Sleep) == 0 || len(got.HR) == 0 || len(got.SpO2) == 0 ||
		len(got.Stress) == 0 || len(got.DayStats) == 0 || len(got.Workouts) == 0 {
		t.Fatalf("sealed event missing a stream: %+v", got)
	}
	// GPS must never reach the sealed payload.
	for _, banned := range []string{"latitude", "longitude", "gps", "13.4", "52.5"} {
		if bytes.Contains(opened, []byte(banned)) {
			t.Errorf("sealed payload leaks GPS token %q", banned)
		}
	}

	// The "Queued" ack was edited into an outcome summary.
	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.edits) == 0 {
		t.Fatal("queued ack was never edited into a summary")
	}
}
