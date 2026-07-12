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
	// A sparse backup still splits into bounded events (one aggregate event +
	// one per dense stream). Aggregate stream counts across all of them.
	agg := sumEventStreams(t, events)
	if agg.sleep != 1 {
		t.Errorf("sleep = %d, want 1", agg.sleep)
	}
	if agg.hr != 1 {
		t.Errorf("hr = %d, want 1", agg.hr)
	}
	if agg.spo2 != 1 {
		t.Errorf("spo2 = %d, want 1", agg.spo2)
	}
	if agg.stress != 1 {
		t.Errorf("stress = %d, want 1", agg.stress)
	}
	if agg.daystats != 1 {
		t.Errorf("daystats = %d, want 1", agg.daystats)
	}
	if agg.workouts != 1 {
		t.Errorf("workouts = %d, want 1", agg.workouts)
	}
}

type eventStreamCounts struct{ sleep, hr, spo2, stress, daystats, workouts int }

// sumEventStreams totals each stream across every event, asserting each event
// carries the vitals-import kind and never leaks a GPS token in its wire JSON.
func sumEventStreams(t *testing.T, events []vitalsImportEvent) eventStreamCounts {
	t.Helper()
	var agg eventStreamCounts
	for _, ev := range events {
		if ev.Kind != inboxEventKindVitalsImport {
			t.Errorf("kind = %q, want %q", ev.Kind, inboxEventKindVitalsImport)
		}
		agg.sleep += len(ev.Sleep)
		agg.hr += len(ev.HR)
		agg.spo2 += len(ev.SpO2)
		agg.stress += len(ev.Stress)
		agg.daystats += len(ev.DayStats)
		agg.workouts += len(ev.Workouts)

		// GPS must be absent from every sealed payload — assert on the wire JSON
		// so a stray field on any nested struct is caught, not just the top level.
		blob, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		for _, banned := range []string{"latitude", "longitude", "gps", "altitude", "13.4", "52.5"} {
			if strings.Contains(string(blob), banned) {
				t.Errorf("sealed payload leaks GPS token %q: %s", banned, blob)
			}
		}
	}
	return agg
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
	if len(events) == 0 {
		t.Fatal("queued 0 events, want at least 1")
	}
	// The import splits into many bounded events; open each and aggregate the
	// streams so every one is exercised (kind, no plaintext, no GPS).
	var agg eventStreamCounts
	for _, row := range events {
		// Nothing readable at rest: the kind must not appear in the ciphertext.
		if bytes.Contains(row.CT, []byte(inboxEventKindVitalsImport)) {
			t.Fatal("mailbox row contains plaintext kind")
		}
		opened, err := openInbox(privRaw, f.accountID, row.CT)
		if err != nil {
			t.Fatalf("openInbox: %v", err)
		}
		var got vitalsImportEvent
		if err := json.Unmarshal(opened, &got); err != nil {
			t.Fatalf("unmarshal sealed event: %v", err)
		}
		if got.Kind != inboxEventKindVitalsImport {
			t.Fatalf("sealed event kind = %q", got.Kind)
		}
		agg.sleep += len(got.Sleep)
		agg.hr += len(got.HR)
		agg.spo2 += len(got.SpO2)
		agg.stress += len(got.Stress)
		agg.daystats += len(got.DayStats)
		agg.workouts += len(got.Workouts)
		// GPS must never reach any sealed payload.
		for _, banned := range []string{"latitude", "longitude", "gps", "13.4", "52.5"} {
			if bytes.Contains(opened, []byte(banned)) {
				t.Errorf("sealed payload leaks GPS token %q", banned)
			}
		}
	}
	if agg.sleep == 0 || agg.hr == 0 || agg.spo2 == 0 ||
		agg.stress == 0 || agg.daystats == 0 || agg.workouts == 0 {
		t.Fatalf("sealed events missing a stream: %+v", agg)
	}

	// The "Queued" ack was edited into an outcome summary.
	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.edits) == 0 {
		t.Fatal("queued ack was never edited into a summary")
	}
}

// TestChildWebhook_NXKTooBigTellsOperatorToEnableProxy guards bd med-eas.41: a
// Mi Band backup over Telegram's 20 MB public Bot API limit (getFile returns
// "file is too big") must edit the ack into an honest "enable the local Bot API
// proxy" message, NOT the generic "try sending it again" — which would loop the
// user forever since a retry can never clear a size cap. A genuinely transient
// download failure keeps the retry wording (covered by the existing path).
func TestChildWebhook_NXKTooBigTellsOperatorToEnableProxy(t *testing.T) {
	tg := newRecordingTG(t)
	tg.mu.Lock()
	tg.mu.getFileTooBig = true
	tg.mu.Unlock()

	f := linkedBotTap(t, tg)
	publishInboxKey(t, f.store, f.accountID)

	// file_size passes ValidateImportFile (<= its cap) but getFile still refuses
	// it: the two limits are independent, and this is the whole point of the bug.
	update := `{"update_id":7,"message":{"message_id":9,"chat":{"id":12345,"type":"private"},` +
		`"document":{"file_id":"BIGNXK","file_name":"export.nxk","file_size":1024}}}`
	rec := postWebhook(t, f.top, f.childPath, f.secret, update)
	if rec.Code != http.StatusOK {
		t.Fatalf("nxk too-big webhook status = %d, body %q", rec.Code, rec.Body.String())
	}

	// Nothing sealed — the download never produced a file.
	events, err := f.store.ListInboxEvents(t.Context(), f.accountID, 10)
	if err != nil {
		t.Fatalf("ListInboxEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("queued %d events, want 0 (download failed)", len(events))
	}

	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.edits) == 0 {
		t.Fatal("queued ack was never edited")
	}
	last := tg.mu.edits[len(tg.mu.edits)-1]
	if !strings.Contains(last, "20 MB") || !strings.Contains(last, "proxy") {
		t.Errorf("too-big ack = %q, want the honest 20 MB / proxy message", last)
	}
	if strings.Contains(last, "try sending it again") {
		t.Errorf("too-big ack used the misleading retry wording: %q", last)
	}
}
