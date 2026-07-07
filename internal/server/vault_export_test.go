package server

import (
	"context"
	"encoding/json"
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
	empty, err := srv.buildVault(ctx, userID)
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

	v, err := srv.buildVault(ctx, userID)
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
}
