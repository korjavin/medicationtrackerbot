package scheduler

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/testharness"
)

type MockNotifier struct {
	Notifications []notifier.Notification
}

func (m *MockNotifier) Send(ctx context.Context, userID int64, n notifier.Notification) (int, error) {
	if n.Metadata["type"] != "medication_batch" {
		m.Notifications = append(m.Notifications, n)
	}
	return 1, nil
}

func (m *MockNotifier) Delete(ctx context.Context, userID int64, msgID int) error {
	return nil
}

func (m *MockNotifier) CloseNotification(ctx context.Context, userID int64, tag string) error {
	return nil
}

type medicationScenarioInput struct {
	Medications []struct {
		Name      string  `json:"name"`
		Dosage    string  `json:"dosage"`
		Schedule  string  `json:"schedule"`
		StartDate *string `json:"start_date"`
		EndDate   *string `json:"end_date"`
	} `json:"medications"`
	TimeNow         string `json:"time_now"`
	ExistingIntakes []struct {
		MedicationName string `json:"medication_name"`
		ScheduledTime  string `json:"scheduled_time"`
	} `json:"existing_intakes"`
}

type medicationScenarioExpected struct {
	Notifications  int `json:"notifications"`
	PendingIntakes int `json:"pending_intakes"`
}

func TestMedicationCheckerScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "medication_scenarios.json")

	testharness.RunScenarios(t, filename, func(t *testing.T, s testharness.Scenario) {
		var input medicationScenarioInput
		if err := json.Unmarshal(s.Input, &input); err != nil {
			t.Fatalf("Failed to unmarshal input: %v", err)
		}

		var expected medicationScenarioExpected
		if err := json.Unmarshal(s.Expected, &expected); err != nil {
			t.Fatalf("Failed to unmarshal expected: %v", err)
		}

		db, err := store.New(":memory:")
		if err != nil {
			t.Fatalf("Failed to create memory db: %v", err)
		}
		defer db.Close() // #nosec G104

		if err := db.SetMedicationEnabled(context.Background(), true); err != nil {
			t.Fatalf("SetMedicationEnabled failed: %v", err)
		}

		nowTime, err := time.Parse(time.RFC3339, input.TimeNow)
		if err != nil {
			t.Fatalf("Failed to parse TimeNow: %v", err)
		}

		// Pre-populate db
		medNameMap := make(map[string]int64)
		for _, m := range input.Medications {
			var sd, ed *time.Time
			if m.StartDate != nil {
				parsed, err := time.Parse(time.RFC3339, *m.StartDate)
				if err == nil {
					sd = &parsed
				}
			}
			if m.EndDate != nil {
				parsed, err := time.Parse(time.RFC3339, *m.EndDate)
				if err == nil {
					ed = &parsed
				}
			}

			id, err := db.CreateMedication(m.Name, m.Dosage, m.Schedule, sd, ed, "", "")
			if err != nil {
				t.Fatalf("CreateMedication failed: %v", err)
			}
			medNameMap[m.Name] = id
		}

		for _, ei := range input.ExistingIntakes {
			medID, ok := medNameMap[ei.MedicationName]
			if !ok {
				t.Fatalf("Existing intake refs unknown medication: %s", ei.MedicationName)
			}
			st, err := time.Parse(time.RFC3339, ei.ScheduledTime)
			if err != nil {
				t.Fatalf("Failed to parse ExistingIntake scheduled time: %v", err)
			}
			_, err = db.CreateIntake(medID, 123456, st)
			if err != nil {
				t.Fatalf("CreateIntake failed: %v", err)
			}
		}

		mockNotifier := &MockNotifier{}

		sched := New(db, 123456, []notifier.Notifier{mockNotifier})

		// Override current time for test
		sched.MedicationChecker.now = func() time.Time {
			return nowTime
		}

		err = sched.MedicationChecker.Check(context.Background())
		if err != nil {
			t.Errorf("Check returned error: %v", err)
		}

		// Wait briefly for fire-and-forget notifications to be processed
		time.Sleep(10 * time.Millisecond)

		pending, err := db.GetPendingIntakes()
		if err != nil {
			t.Fatalf("GetPendingIntakes failed: %v", err)
		}

		actual := medicationScenarioExpected{
			Notifications:  len(mockNotifier.Notifications),
			PendingIntakes: len(pending),
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
