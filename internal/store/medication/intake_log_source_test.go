package medication

import (
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
	_ "modernc.org/sqlite"
)

// TestIntakeLog_DefaultSourceIsSchedule pins Task 9's "no behaviour change yet"
// guarantee: every intake row created via the existing writers gets the
// default source='schedule' value. The new tz_plan_id / tz_step_number
// columns stay NULL until Track D's materialize path lands in Task 10.
func TestIntakeLog_DefaultSourceIsSchedule(t *testing.T) {
	r := setupMedicationRepo(t)

	medID, err := r.Create("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	scheduledAt := time.Date(2026, 5, 16, 8, 0, 0, 0, time.UTC)
	autoID, err := r.CreateIntake(medID, 1, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	manualID, err := r.CreateManualIntake(medID, 1, scheduledAt.Add(1*time.Hour))
	if err != nil {
		t.Fatalf("CreateManualIntake: %v", err)
	}

	for _, tc := range []struct {
		name string
		id   int64
	}{
		{"CreateIntake", autoID},
		{"CreateManualIntake", manualID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := r.GetIntake(tc.id)
			if err != nil {
				t.Fatalf("GetIntake: %v", err)
			}
			if got == nil {
				t.Fatalf("GetIntake returned nil")
			}
			if got.Source != "schedule" {
				t.Errorf("Source=%q, want %q (default for non-materialized rows)", got.Source, "schedule")
			}
			if got.TZPlanID != nil {
				t.Errorf("TZPlanID=%v, want nil (only set for source='tz_step' rows)", *got.TZPlanID)
			}
			if got.TZStepNumber != nil {
				t.Errorf("TZStepNumber=%v, want nil (only set for source='tz_step' rows)", *got.TZStepNumber)
			}
		})
	}
}

// TestIntakeLog_TZPlanIDSetNullOnPlanDelete asserts the migration 066 FK
// clause is actually declared on the column: with PRAGMA foreign_keys=ON,
// deleting a referenced tz_transition_plans row clears tz_plan_id on the
// associated intake_log rows (ON DELETE SET NULL).
//
// At runtime this project keeps PRAGMA foreign_keys OFF (see the migration
// comment), so the cascade is documentation of intent rather than enforced
// behaviour. The test turns FKs on locally to verify the schema declaration
// is correct so that a future global flip would do the right thing.
func TestIntakeLog_TZPlanIDSetNullOnPlanDelete(t *testing.T) {
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := d.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable FKs: %v", err)
	}

	r := New(d)

	medID, err := r.Create("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Insert a tz_transition_plans row directly. We don't depend on the tz
	// repo's writer here — the FK constraint we're testing is purely a schema
	// property.
	planRes, err := d.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES ('UTC', 'Europe/Berlin', 'APPROVED', '[]', '{}', 'hash-task9')`,
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	planID, err := planRes.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId(plan): %v", err)
	}

	// Insert two intake rows: one linked to the plan via tz_plan_id, one
	// unlinked. Use raw SQL so we exercise the column directly — the Task 10
	// writer that does this through the domain service doesn't exist yet.
	scheduledUnix := time.Date(2026, 5, 16, 8, 0, 0, 0, time.UTC).Unix()
	linkedRes, err := d.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, ?)`,
		medID, int64(1), scheduledUnix, planID, int64(2),
	)
	if err != nil {
		t.Fatalf("insert linked intake: %v", err)
	}
	linkedID, err := linkedRes.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId(linked): %v", err)
	}

	unlinkedID, err := r.CreateIntake(medID, 1, time.Date(2026, 5, 16, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("CreateIntake(unlinked): %v", err)
	}

	if _, err := d.Exec("DELETE FROM tz_transition_plans WHERE id = ?", planID); err != nil {
		t.Fatalf("delete plan: %v", err)
	}

	linked, err := r.GetIntake(linkedID)
	if err != nil {
		t.Fatalf("GetIntake(linked): %v", err)
	}
	if linked == nil {
		t.Fatalf("linked intake was deleted; ON DELETE SET NULL should preserve the row")
	}
	if linked.TZPlanID != nil {
		t.Errorf("TZPlanID=%v after plan delete, want nil (ON DELETE SET NULL)", *linked.TZPlanID)
	}
	if linked.Source != "tz_step" {
		t.Errorf("Source=%q, want %q (source must not be cleared by FK action)", linked.Source, "tz_step")
	}

	unlinked, err := r.GetIntake(unlinkedID)
	if err != nil {
		t.Fatalf("GetIntake(unlinked): %v", err)
	}
	if unlinked == nil {
		t.Fatalf("unlinked intake disappeared")
	}
	if unlinked.TZPlanID != nil {
		t.Errorf("unlinked TZPlanID=%v, want nil", *unlinked.TZPlanID)
	}
}
