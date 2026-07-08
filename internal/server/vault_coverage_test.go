package server

import (
	"context"
	"sort"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// vaultCovered lists the tables whose rows the vault carries end-to-end
// (exported by buildVault, restored by importVault). Every table WipeUserTx
// deletes from must appear here or in vaultSkipped — a table that is wiped on
// import but not exported is silent data loss, which is the bug this guard
// exists to catch.
var vaultCovered = []string{
	"blood_pressure_readings",
	"bp_reminder_state",
	"day_stats",
	"diary_notes",
	"exercise_library",
	"food_log",
	"food_products",
	"gamification_ledger",
	"gamification_state",
	"gamification_targets",
	"intake_log",
	"medication_restocks",
	"medications",
	"miband_gps_tracks",
	"miband_workouts",
	"sleep_logs",
	"timezone_history",
	"tz_transition_plans",
	"vitals_heart",
	"vitals_spo2",
	"vitals_stress",
	"weight_goals",
	"weight_logs",
	"weight_reminder_state",
	"workout_exercise_logs",
	"workout_exercises",
	"workout_groups",
	"workout_rotation_state",
	"workout_sessions",
	"workout_variants",
}

// vaultSkipped lists the wiped tables the vault deliberately does not carry.
// Each entry is a decision, not an oversight; the reason is the record of it.
var vaultSkipped = map[string]string{
	"push_subscriptions":         "device-bound web-push endpoints + keys; meaningless on another browser or server",
	"intake_reminders":           "Telegram message ids for reminder edits; transient chat state, not health data",
	"change_events":              "SSE change-feed tag stream; rebuilt by triggers as the import writes rows",
	"workout_schedule_snapshots": "write-only: CreateGroupSnapshot has callers, ListGroupSnapshots has none, so nothing can read the data back",
}

// vaultCoveredNotWiped lists tables the vault carries that WipeUserTx does not
// delete. Both entries are intentional: settings is a singleton row the import
// UPDATEs in place, and api_tokens survives a secrets-free import by design
// (see docs/vault-format.md — an absent api_tokens block leaves the target's
// tokens alone rather than unminting them).
var vaultCoveredNotWiped = map[string]string{
	"settings":   "singleton row; import UPDATEs the vault-owned columns rather than deleting the row",
	"api_tokens": "asymmetric import: absent block leaves existing tokens alone, present block replaces them",
}

func TestVaultWipeAndExportAgree(t *testing.T) {
	covered := map[string]bool{}
	for _, tbl := range vaultCovered {
		if covered[tbl] {
			t.Errorf("vaultCovered lists %q twice", tbl)
		}
		covered[tbl] = true
	}
	for tbl := range vaultSkipped {
		if covered[tbl] {
			t.Errorf("%q is in both vaultCovered and vaultSkipped — pick one", tbl)
		}
	}
	for tbl, reason := range vaultSkipped {
		if reason == "" {
			t.Errorf("vaultSkipped[%q] needs a Reason explaining why the data is not worth carrying", tbl)
		}
	}

	wiped := map[string]bool{}
	for _, tbl := range seeddemo.WipedTables() {
		wiped[tbl] = true
	}

	// Direction 1: everything the import wipes must be restored or knowingly dropped.
	for _, tbl := range sortedKeys(wiped) {
		if covered[tbl] || vaultSkipped[tbl] != "" {
			continue
		}
		t.Errorf("table %q is deleted by seeddemo.WipeUserTx but the vault neither exports it nor lists it in vaultSkipped: "+
			"a replace-import silently destroys it. Add it to the vault (export + import + fixture) or to vaultSkipped with a reason.", tbl)
	}

	// Direction 2: everything the vault claims to carry must be wiped first,
	// or the import doubles up rows on top of the target's existing data.
	for _, tbl := range vaultCovered {
		if wiped[tbl] || vaultCoveredNotWiped[tbl] != "" {
			continue
		}
		t.Errorf("table %q is in vaultCovered but seeddemo.WipeUserTx does not delete from it: "+
			"importing would append to the target's existing rows. Add it to the wipe manifest.", tbl)
	}

	// A skip-list entry for a table nobody wipes is stale bookkeeping.
	for _, tbl := range sortedKeys(vaultSkipped) {
		if !wiped[tbl] {
			t.Errorf("vaultSkipped lists %q but WipeUserTx no longer deletes from it — drop the entry", tbl)
		}
	}
	for _, tbl := range sortedKeys(vaultCoveredNotWiped) {
		if wiped[tbl] {
			t.Errorf("vaultCoveredNotWiped lists %q but WipeUserTx does delete from it — drop the entry", tbl)
		}
	}

	// Guard against typos in the lists above: every named table must exist.
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	real := map[string]bool{}
	rows, err := db.DB().QueryContext(context.Background(),
		`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		real[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	named := append([]string{}, vaultCovered...)
	named = append(named, sortedKeys(vaultSkipped)...)
	named = append(named, sortedKeys(vaultCoveredNotWiped)...)
	named = append(named, seeddemo.WipedTables()...)
	for _, tbl := range named {
		if !real[tbl] {
			t.Errorf("table %q is named by the vault-coverage lists (or the wipe manifest) but does not exist in the migrated schema", tbl)
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
