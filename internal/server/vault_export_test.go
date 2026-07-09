package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

// TestVaultFixtureRoundTrips pins the Go vault structs against the shared
// golden fixture tests/fixtures/vault-v1.json: unmarshal → re-marshal must be
// semantically identical (modulo exported_at). Any field-name drift or a
// missing struct field drops data on unmarshal and fails this pin — the same
// file the Vitest cloud round-trip pins (Task 7 cross-runtime contract).
func TestVaultFixtureRoundTrips(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "vault-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var v Vault
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal fixture into Vault: %v", err)
	}
	if v.Format != vaultFormat || v.Version != vaultVersion {
		t.Fatalf("envelope mismatch: format=%q version=%d", v.Format, v.Version)
	}

	remarshaled, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal Vault: %v", err)
	}

	got := decodeIgnoringExportedAt(t, remarshaled)
	want := decodeIgnoringExportedAt(t, raw)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-trip through Vault structs is not identity.\nThe struct set drifted from tests/fixtures/vault-v1.json (missing/renamed field).\n got=%s\nwant=%s", remarshaled, raw)
	}
}

func decodeIgnoringExportedAt(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	delete(m, "exported_at")
	return m
}

// TestVaultExportHandler drives buildVault end-to-end against a real (migrated)
// SQLite schema: it proves every domain walk — including the raw mi-band and
// tz-history queries — runs without error, and that the two genuine storage
// conversions (intake unix-seconds → RFC3339, mi-band millisecond passthrough)
// map correctly.
func TestVaultExportHandler(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 123
	ctx := context.Background()

	// Empty-DB export must succeed and carry a valid envelope.
	empty, err := srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault on empty db: %v", err)
	}
	if empty.Format != vaultFormat || empty.Version != vaultVersion {
		t.Fatalf("empty envelope wrong: %+v", empty.Format)
	}

	// Seed the two conversion-sensitive paths.
	medID, err := db.Medication.Create("Test Med", "5mg", "09:00", nil, nil, "", "", "flexible")
	if err != nil {
		t.Fatalf("create med: %v", err)
	}
	scheduled := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)
	if _, err := db.Medication.CreateIntake(medID, userID, scheduled); err != nil {
		t.Fatalf("create intake: %v", err)
	}

	const startMs int64 = 1_740_000_000_000
	mb := workout.MiBandWorkout{
		UserID:        userID,
		SourceStartMs: startMs,
		SourceEndMs:   startMs + 1_800_000,
		ActivityType:  1,
		ActivityName:  "Run",
		DurationSec:   1800,
		DistanceM:     5000,
		Steps:         6000,
		Calories:      400,
		Source:        "device",
	}
	gps := map[int64][]workout.MiBandGPSPoint{
		startMs: {{PointIndex: 0, TsMs: startMs, Latitude: 52.5, Longitude: 13.4, Altitude: 30}},
	}
	if _, _, err := db.Workout.ImportMiBand(ctx, []workout.MiBandWorkout{mb}, gps); err != nil {
		t.Fatalf("import miband: %v", err)
	}

	v, err := srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}

	if len(v.Data.Medications.Items) != 1 || v.Data.Medications.Items[0].Name != "Test Med" {
		t.Fatalf("medication not exported: %+v", v.Data.Medications.Items)
	}
	if len(v.Data.Medications.Intakes) != 1 {
		t.Fatalf("want 1 intake, got %d", len(v.Data.Medications.Intakes))
	}
	if got := v.Data.Medications.Intakes[0].ScheduledAt.UTC(); !got.Equal(scheduled) {
		t.Fatalf("intake scheduled_at conversion wrong: got %s want %s", got, scheduled)
	}

	if len(v.Data.Workouts.MiBand) != 1 {
		t.Fatalf("want 1 miband workout, got %d", len(v.Data.Workouts.MiBand))
	}
	w := v.Data.Workouts.MiBand[0]
	if w.SourceStartMs != startMs {
		t.Fatalf("miband source_start_ms passthrough wrong: got %d want %d", w.SourceStartMs, startMs)
	}
	if len(w.GPS) != 1 || w.GPS[0].TsMs != startMs {
		t.Fatalf("miband gps not exported: %+v", w.GPS)
	}

	// Settings singletons always resolve (migrated schema seeds row id=1).
	if v.Data.Settings.FoodTargets == nil {
		t.Fatalf("food targets missing from settings")
	}

	// No reminder-state row for this user yet → the block stays absent.
	if v.Data.Settings.BPReminder != nil || v.Data.Settings.WeightReminder != nil {
		t.Fatalf("reminder state should be absent before seeding: bp=%+v weight=%+v", v.Data.Settings.BPReminder, v.Data.Settings.WeightReminder)
	}

	// The four new domain walks, seeded raw (no store repos exist for them here).
	seedNewVaultBlocks(t, db, userID)

	v, err = srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault after seeding new blocks: %v", err)
	}

	bpRem, wtRem := v.Data.Settings.BPReminder, v.Data.Settings.WeightReminder
	if bpRem == nil || !bpRem.Enabled || bpRem.PreferredReminderHour != 20 || bpRem.SnoozedUntil == nil || bpRem.DontRemindUntil != nil {
		t.Fatalf("bp reminder state: %+v", bpRem)
	}
	if wtRem == nil || wtRem.Enabled || wtRem.PreferredReminderHour != 7 || wtRem.SnoozedUntil != nil {
		t.Fatalf("weight reminder state: %+v", wtRem)
	}

	if len(v.Data.Gamification.Targets) != 2 || v.Data.Gamification.Targets[0].MetricKey != "sleep_minutes" {
		t.Fatalf("gamification targets: %+v", v.Data.Gamification.Targets)
	}
	if len(v.Data.Gamification.Ledger) != 2 {
		t.Fatalf("want 2 ledger rows, got %d", len(v.Data.Gamification.Ledger))
	}
	if got := v.Data.Gamification.Ledger[0].Day.UTC(); !got.Equal(time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("ledger day unix→time wrong: %s", got)
	}
	if v.Data.Gamification.State == nil || v.Data.Gamification.State.LifetimeHP != 1355 {
		t.Fatalf("gamification state: %+v", v.Data.Gamification.State)
	}

	if len(v.Data.TZ.TransitionPlans) != 2 {
		t.Fatalf("want both tz plans (oldest first), got %d", len(v.Data.TZ.TransitionPlans))
	}
	if v.Data.TZ.TransitionPlans[0].Status != "COMPLETED" || v.Data.TZ.TransitionPlans[1].Status != "PENDING_APPROVAL" {
		t.Fatalf("tz plans out of order: %+v", v.Data.TZ.TransitionPlans)
	}
	if p := v.Data.TZ.TransitionPlans[0]; p.PlanHash != "h1" || p.UserAction != "APPROVED" || p.ApprovedAt == nil || len(p.Steps) != 1 {
		t.Fatalf("tz plan fields dropped: %+v", p)
	}
	if v.Data.TZ.TransitionPlans[1].ApprovedAt != nil {
		t.Fatalf("pending plan should have null approved_at")
	}

	if v.Data.APITokens == nil || len(*v.Data.APITokens) != 2 {
		t.Fatalf("api tokens: %+v", v.Data.APITokens)
	}
	if (*v.Data.APITokens)[0].Name != "mcp-laptop" || (*v.Data.APITokens)[1].LastUsedAt != nil {
		t.Fatalf("api token fields wrong: %+v", *v.Data.APITokens)
	}
}

// TestVaultExportSecretsOmitted pins the include_secrets toggle: the two
// secret-bearing blocks must be *absent* (not empty) when it's off, since
// absent is what tells the importer to leave the destination's secrets alone.
func TestVaultExportSecretsOmitted(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 123
	seedNewVaultBlocks(t, db, userID)

	off, err := srv.buildVault(context.Background(), userID, false)
	if err != nil {
		t.Fatalf("buildVault(includeSecrets=false): %v", err)
	}
	if off.Data.APITokens != nil {
		t.Errorf("api_tokens present with include_secrets=0: %+v", *off.Data.APITokens)
	}
	if off.Data.Settings.Integrations != nil {
		t.Errorf("settings.integrations present with include_secrets=0")
	}
	// Non-secret settings still export.
	if off.Data.Settings.FoodTargets == nil {
		t.Errorf("food targets dropped by include_secrets=0")
	}

	// The handler's query parsing: absent and "1"/"true" include. Anything else
	// present — including an unrecognized value — must fail closed rather than
	// silently ship the operator's provider keys.
	for _, tc := range []struct {
		query string
		want  bool
	}{
		{"", true}, {"?include_secrets=1", true}, {"?include_secrets=true", true},
		{"?include_secrets=0", false}, {"?include_secrets=false", false},
		{"?include_secrets=no", false}, {"?include_secrets=False", false}, {"?include_secrets=off", false},
		{"?include_secrets=", false}, {"?include_secrets", false},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/export"+tc.query, nil)
		req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))
		rec := httptest.NewRecorder()
		srv.handleVaultExport(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("export%q: status %d", tc.query, rec.Code)
		}
		var body struct {
			Data struct {
				APITokens *[]VaultAPIToken `json:"api_tokens"`
				Settings  struct {
					Integrations *VaultIntegrations `json:"integrations"`
				} `json:"settings"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode export%q: %v", tc.query, err)
		}
		hasTokens := body.Data.APITokens != nil
		hasKeys := body.Data.Settings.Integrations != nil
		if hasTokens != tc.want || hasKeys != tc.want {
			t.Errorf("export%q: api_tokens=%v integrations=%v, want both %v", tc.query, hasTokens, hasKeys, tc.want)
		}
	}
}

// seedNewVaultBlocks writes gamification, api-token and two-plan tz rows
// directly — these tables have no store repo the export path goes through.
func seedNewVaultBlocks(t *testing.T, db *store.Repos, userID int64) {
	t.Helper()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.DB().Exec(q, args...); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO bp_reminder_state (user_id, enabled, snoozed_until, preferred_reminder_hour) VALUES (?, 1, ?, 20)`,
		userID, "2026-07-08T18:00:00Z")
	exec(`INSERT INTO weight_reminder_state (user_id, enabled, preferred_reminder_hour) VALUES (?, 0, 7)`, userID)

	exec(`INSERT INTO gamification_targets (user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix)
	      VALUES (?, 'steps', 6000, 12000, 2000, 'range', ?), (?, 'sleep_minutes', 420, NULL, NULL, 'at_least', ?)`,
		userID, time.Date(2026, 6, 10, 8, 0, 0, 0, time.UTC).Unix(),
		userID, time.Date(2026, 6, 11, 8, 0, 0, 0, time.UTC).Unix())
	exec(`INSERT INTO gamification_ledger (user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix)
	      VALUES (?, ?, 'move', 'steps', 'in_range', 30, '{"steps":9500}', ?), (?, ?, 'rest', 'sleep_minutes', 'in_range', 25, NULL, ?)`,
		userID, time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC).Unix(), time.Date(2026, 7, 7, 0, 5, 0, 0, time.UTC).Unix(),
		userID, time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC).Unix(), time.Date(2026, 7, 8, 0, 5, 0, 0, time.UTC).Unix())
	exec(`INSERT INTO gamification_state (user_id, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier, last_scored_day_unix, backfilled_at_unix, updated_at_unix)
	      VALUES (?, 1355, 4, 6, 21, 1, 2, ?, ?, ?)`,
		userID, time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC).Unix(),
		time.Date(2026, 6, 1, 3, 0, 0, 0, time.UTC).Unix(), time.Date(2026, 7, 8, 0, 5, 0, 0, time.UTC).Unix())

	exec(`INSERT INTO tz_transition_plans (old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash, approved_at_unix, user_action, notified_at_unix)
	      VALUES ('America/New_York', 'Europe/Berlin', ?, 'COMPLETED', ?, '{}', 'h1', ?, 'APPROVED', ?)`,
		time.Date(2026, 5, 2, 9, 0, 0, 0, time.UTC).Unix(),
		`[{"medication_id":1,"med_name":"Lisinopril","step_number":1,"total_steps":1,"scheduled_at":"2026-05-03T08:00:00Z","note":"shift 1h later"}]`,
		time.Date(2026, 5, 2, 9, 30, 0, 0, time.UTC).Unix(), time.Date(2026, 5, 2, 9, 5, 0, 0, time.UTC).Unix())
	exec(`INSERT INTO tz_transition_plans (old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash)
	      VALUES ('Europe/Berlin', 'America/New_York', ?, 'PENDING_APPROVAL', '[]', '{}', 'h2')`,
		time.Date(2026, 7, 8, 10, 0, 0, 0, time.UTC).Unix())

	exec(`INSERT INTO api_tokens (name, token_hash, created_at, last_used_at) VALUES ('mcp-laptop', 'hash-1', ?, ?)`,
		"2026-05-20T12:00:00Z", "2026-07-07T19:30:00Z")
	exec(`INSERT INTO api_tokens (name, token_hash, created_at, last_used_at) VALUES ('home-assistant', 'hash-2', ?, NULL)`,
		"2026-06-02T12:00:00Z")
}

// TestVaultExportGzip pins the wire compression: a gzip-accepting client gets a
// Content-Encoding: gzip body that decompresses to the same vault a plain
// client receives. A regression here silently ships a 10x-larger response (or,
// worse, a gzip body without the header — unreadable JSON).
func TestVaultExportGzip(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	call := func(acceptEncoding string) (*httptest.ResponseRecorder, []byte) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/export", nil)
		if acceptEncoding != "" {
			r.Header.Set("Accept-Encoding", acceptEncoding)
		}
		r = r.WithContext(context.WithValue(r.Context(), UserCtxKey, &TelegramUser{ID: 123}))
		w := httptest.NewRecorder()
		srv.handleVaultExport(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d", w.Code)
		}
		return w, w.Body.Bytes()
	}

	plainRes, plain := call("")
	if enc := plainRes.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("no Accept-Encoding: unexpected Content-Encoding %q", enc)
	}
	if plainRes.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("missing Vary: Accept-Encoding")
	}

	gzRes, gzBody := call("gzip, deflate, br")
	if enc := gzRes.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gzBody))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	// Ignore exported_at: the two calls are stamped independently and can land in
	// different seconds (passes locally, fails on a slower CI runner).
	if !reflect.DeepEqual(decodeIgnoringExportedAt(t, got), decodeIgnoringExportedAt(t, plain)) {
		t.Fatalf("gunzipped body differs from plain body:\n got=%s\nwant=%s", got, plain)
	}
}
