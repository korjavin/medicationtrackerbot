package domain

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Ensure mockMedicationStore satisfies the MedicationStore interface at compile time.
var _ MedicationStore = (*mockMedicationStore)(nil)

// mockMedicationStore implements MedicationStore for testing.
type mockMedicationStore struct {
	getIntakeFn                   func(id int64) (*store.IntakeLog, error)
	getMedicationFn               func(id int64) (*store.Medication, error)
	getIntakeRemindersFn          func(intakeID int64) ([]int, error)
	getPendingIntakesFn           func() ([]store.IntakeLog, error)
	getPendingIntakesByScheduleFn func(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	confirmIntakeFn               func(id int64, takenAt time.Time) error
	confirmIntakesByScheduleFn    func(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error)
	skipIntakeFn                  func(id int64) error
	snoozeIntakeFn                func(id int64, snoozeUntil time.Time) error
	createIntakeFn                func(medID, userID int64, scheduledAt time.Time) (int64, error)
	createManualIntakeFn          func(medID, userID int64, takenAt time.Time) (int64, error)
	decrementInventoryFn          func(medID int64, qty int) error
	lastConfirmedID               int64
	decrementedMedIDs             []int64
}

func (m *mockMedicationStore) GetIntake(id int64) (*store.IntakeLog, error) {
	if m.getIntakeFn != nil {
		return m.getIntakeFn(id)
	}
	return nil, nil
}

func (m *mockMedicationStore) GetMedication(id int64) (*store.Medication, error) {
	if m.getMedicationFn != nil {
		return m.getMedicationFn(id)
	}
	return nil, nil
}

func (m *mockMedicationStore) GetIntakeReminders(intakeID int64) ([]int, error) {
	if m.getIntakeRemindersFn != nil {
		return m.getIntakeRemindersFn(intakeID)
	}
	return nil, nil
}

func (m *mockMedicationStore) GetPendingIntakes() ([]store.IntakeLog, error) {
	if m.getPendingIntakesFn != nil {
		return m.getPendingIntakesFn()
	}
	return nil, nil
}

func (m *mockMedicationStore) GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error) {
	if m.getPendingIntakesByScheduleFn != nil {
		return m.getPendingIntakesByScheduleFn(userID, scheduledAt)
	}
	return nil, nil
}

func (m *mockMedicationStore) ConfirmIntake(id int64, takenAt time.Time) error {
	m.lastConfirmedID = id
	if m.confirmIntakeFn != nil {
		return m.confirmIntakeFn(id, takenAt)
	}
	return nil
}

func (m *mockMedicationStore) ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
	if m.confirmIntakesByScheduleFn != nil {
		return m.confirmIntakesByScheduleFn(userID, scheduledAt, takenAt)
	}
	return nil, nil
}

func (m *mockMedicationStore) SkipIntake(id int64) error {
	if m.skipIntakeFn != nil {
		return m.skipIntakeFn(id)
	}
	return nil
}

func (m *mockMedicationStore) SnoozeIntake(id int64, snoozeUntil time.Time) error {
	if m.snoozeIntakeFn != nil {
		return m.snoozeIntakeFn(id, snoozeUntil)
	}
	return nil
}

func (m *mockMedicationStore) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	if m.createIntakeFn != nil {
		return m.createIntakeFn(medID, userID, scheduledAt)
	}
	return 1, nil
}

func (m *mockMedicationStore) CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error) {
	if m.createManualIntakeFn != nil {
		return m.createManualIntakeFn(medID, userID, takenAt)
	}
	return 1, nil
}

func (m *mockMedicationStore) DecrementInventory(medID int64, qty int) error {
	m.decrementedMedIDs = append(m.decrementedMedIDs, medID)
	if m.decrementInventoryFn != nil {
		return m.decrementInventoryFn(medID, qty)
	}
	return nil
}

// pendingIntake returns a helper PENDING IntakeLog.
func pendingIntake(id, medID int64) *store.IntakeLog {
	return &store.IntakeLog{ID: id, MedicationID: medID, UserID: 1, Status: "PENDING"}
}

func TestConfirmIntakeWithCleanup(t *testing.T) {
	takenAt := time.Now()

	tests := []struct {
		name              string
		store             *mockMedicationStore
		intakeID          int64
		wantReminderIDs   []int
		wantIsSupplement  bool
		wantErr           error
		wantErrContains   string
	}{
		{
			name: "pending intake returns reminder IDs",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getMedicationFn:      func(id int64) (*store.Medication, error) { return &store.Medication{ID: id, Supplement: false}, nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return []int{101, 102}, nil },
				confirmIntakeFn:      func(id int64, takenAt time.Time) error { return nil },
				decrementInventoryFn: func(medID int64, qty int) error { return nil },
			},
			intakeID:        42,
			wantReminderIDs: []int{101, 102},
		},
		{
			name: "supplement intake sets isSupplement true",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getMedicationFn:      func(id int64) (*store.Medication, error) { return &store.Medication{ID: id, Supplement: true}, nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return []int{55}, nil },
				confirmIntakeFn:      func(id int64, takenAt time.Time) error { return nil },
				decrementInventoryFn: func(medID int64, qty int) error { return nil },
			},
			intakeID:         42,
			wantReminderIDs:  []int{55},
			wantIsSupplement: true,
		},
		{
			name: "nil intake returns ErrNotPending",
			store: &mockMedicationStore{
				getIntakeFn: func(id int64) (*store.IntakeLog, error) { return nil, nil },
			},
			intakeID: 42,
			wantErr:  ErrNotPending,
		},
		{
			name: "already-taken intake returns ErrNotPending",
			store: &mockMedicationStore{
				getIntakeFn: func(id int64) (*store.IntakeLog, error) {
					return &store.IntakeLog{ID: id, MedicationID: 10, Status: "TAKEN"}, nil
				},
			},
			intakeID: 42,
			wantErr:  ErrNotPending,
		},
		{
			name: "store error on GetIntake propagates",
			store: &mockMedicationStore{
				getIntakeFn: func(id int64) (*store.IntakeLog, error) {
					return nil, errors.New("db error")
				},
			},
			intakeID:        42,
			wantErrContains: "get intake",
		},
		{
			name: "ConfirmIntake error propagates",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return nil, nil },
				confirmIntakeFn:      func(id int64, takenAt time.Time) error { return errors.New("db write error") },
			},
			intakeID:        42,
			wantErrContains: "confirm intake",
		},
		{
			name: "DecrementInventory error is non-fatal",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return []int{55}, nil },
				confirmIntakeFn:      func(id int64, takenAt time.Time) error { return nil },
				decrementInventoryFn: func(medID int64, qty int) error { return errors.New("inventory error") },
			},
			intakeID:        42,
			wantReminderIDs: []int{55},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewMedicationService(tt.store)
			ids, isSupp, _, _, err := svc.ConfirmIntakeWithCleanup(tt.intakeID, takenAt)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("want error %v, got %v", tt.wantErr, err)
				}
				return
			}
			if tt.wantErrContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Errorf("want error containing %q, got %v", tt.wantErrContains, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !equalIntSlice(ids, tt.wantReminderIDs) {
				t.Errorf("reminder IDs: got %v, want %v", ids, tt.wantReminderIDs)
			}
			if isSupp != tt.wantIsSupplement {
				t.Errorf("isSupplement: got %v, want %v", isSupp, tt.wantIsSupplement)
			}
		})
	}
}

func TestSkipIntake(t *testing.T) {

	tests := []struct {
		name            string
		store           *mockMedicationStore
		intakeID        int64
		wantReminderIDs []int
		wantErr         error
		wantErrContains string
	}{
		{
			name: "intake is skipped",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return []int{200, 201}, nil },
				skipIntakeFn:         func(id int64) error { return nil },
			},
			intakeID:        7,
			wantReminderIDs: []int{200, 201},
		},
		{
			name: "non-pending intake returns ErrNotPending",
			store: &mockMedicationStore{
				getIntakeFn: func(id int64) (*store.IntakeLog, error) {
					return &store.IntakeLog{ID: id, MedicationID: 10, Status: "SKIPPED"}, nil
				},
			},
			intakeID: 7,
			wantErr:  ErrNotPending,
		},
		{
			name: "nil intake returns ErrNotPending",
			store: &mockMedicationStore{
				getIntakeFn: func(id int64) (*store.IntakeLog, error) { return nil, nil },
			},
			intakeID: 7,
			wantErr:  ErrNotPending,
		},
		{
			name: "SkipIntake error propagates",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return nil, nil },
				skipIntakeFn:         func(id int64) error { return errors.New("db error") },
			},
			intakeID:        7,
			wantErrContains: "skip intake",
		},
		{
			name: "SkipIntake sql.ErrNoRows maps to ErrNotPending",
			store: &mockMedicationStore{
				getIntakeFn:          func(id int64) (*store.IntakeLog, error) { return pendingIntake(id, 10), nil },
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return nil, nil },
				skipIntakeFn:         func(id int64) error { return sql.ErrNoRows },
			},
			intakeID: 7,
			wantErr:  ErrNotPending,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewMedicationService(tt.store)
			ids, _, _, err := svc.SkipIntake(tt.intakeID)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("want error %v, got %v", tt.wantErr, err)
				}
				return
			}
			if tt.wantErrContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Errorf("want error containing %q, got %v", tt.wantErrContains, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !equalIntSlice(ids, tt.wantReminderIDs) {
				t.Errorf("reminder IDs: got %v, want %v", ids, tt.wantReminderIDs)
			}
		})
	}
}

func TestLogMedicationNow(t *testing.T) {

	tests := []struct {
		name            string
		store           *mockMedicationStore
		wantErrContains string
	}{
		{
			name: "creates manual intake and decrements inventory",
			store: &mockMedicationStore{
				createManualIntakeFn: func(medID, userID int64, _ time.Time) (int64, error) { return 99, nil },
				decrementInventoryFn: func(medID int64, qty int) error { return nil },
			},
		},
		{
			name: "CreateManualIntake error propagates",
			store: &mockMedicationStore{
				createManualIntakeFn: func(medID, userID int64, _ time.Time) (int64, error) {
					return 0, errors.New("insert failed")
				},
			},
			wantErrContains: "create manual intake",
		},
		{
			name: "DecrementInventory error is non-fatal",
			store: &mockMedicationStore{
				createManualIntakeFn: func(medID, userID int64, _ time.Time) (int64, error) { return 99, nil },
				decrementInventoryFn: func(medID int64, qty int) error { return errors.New("decrement failed") },
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewMedicationService(tt.store)
			err := svc.LogMedicationNow( 1, 10)

			if tt.wantErrContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Errorf("want error containing %q, got %v", tt.wantErrContains, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestConfirmScheduleWithCleanup(t *testing.T) {
	scheduledAt := time.Now().Truncate(time.Minute)

	tests := []struct {
		name                  string
		store                 *mockMedicationStore
		wantReminderIDs       []int
		wantErrContains       string
		wantDecrementedMedIDs []int64
	}{
		{
			name: "multiple intakes collects all reminder IDs",
			store: &mockMedicationStore{
				getPendingIntakesByScheduleFn: func(userID int64, _ time.Time) ([]store.IntakeLog, error) {
					return []store.IntakeLog{
						{ID: 1, MedicationID: 10, Status: "PENDING"},
						{ID: 2, MedicationID: 11, Status: "PENDING"},
					}, nil
				},
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) {
					if intakeID == 1 {
						return []int{100, 101}, nil
					}
					return []int{200}, nil
				},
				confirmIntakesByScheduleFn: func(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) { return []int64{1, 2}, nil },
				decrementInventoryFn:       func(medID int64, qty int) error { return nil },
			},
			wantReminderIDs: []int{100, 101, 200},
		},
		{
			name: "empty slot returns nil reminders but still calls ConfirmIntakesBySchedule",
			store: &mockMedicationStore{
				getPendingIntakesByScheduleFn: func(userID int64, _ time.Time) ([]store.IntakeLog, error) {
					return nil, nil
				},
				confirmIntakesByScheduleFn: func(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) { return nil, nil },
			},
			wantReminderIDs: nil,
		},
		{
			name: "partial confirmation only decrements inventory for confirmed intakes",
			store: &mockMedicationStore{
				getPendingIntakesByScheduleFn: func(userID int64, _ time.Time) ([]store.IntakeLog, error) {
					// 3 pending intakes for medications 10, 11, 12
					return []store.IntakeLog{
						{ID: 1, MedicationID: 10, Status: "PENDING"},
						{ID: 2, MedicationID: 11, Status: "PENDING"},
						{ID: 3, MedicationID: 12, Status: "PENDING"},
					}, nil
				},
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) {
					return []int{100}, nil
				},
				confirmIntakesByScheduleFn: func(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
					// Simulate partial confirmation: only IDs 1 and 2 were confirmed
					// (ID 3 might have been confirmed by another concurrent call)
					return []int64{1, 2}, nil
				},
				decrementInventoryFn: func(medID int64, qty int) error { return nil },
			},
			wantReminderIDs:       []int{100, 100, 100},
			wantDecrementedMedIDs: []int64{10, 11}, // Only medications 10 and 11 should have inventory decremented
		},
		{
			name: "GetPendingIntakesBySchedule error propagates",
			store: &mockMedicationStore{
				getPendingIntakesByScheduleFn: func(userID int64, _ time.Time) ([]store.IntakeLog, error) {
					return nil, errors.New("db error")
				},
			},
			wantErrContains: "get pending intakes by schedule",
		},
		{
			name: "ConfirmIntakesBySchedule error propagates",
			store: &mockMedicationStore{
				getPendingIntakesByScheduleFn: func(userID int64, _ time.Time) ([]store.IntakeLog, error) {
					return []store.IntakeLog{{ID: 1, MedicationID: 10, Status: "PENDING"}}, nil
				},
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) { return nil, nil },
				confirmIntakesByScheduleFn: func(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
					return nil, errors.New("confirm failed")
				},
			},
			wantErrContains: "confirm intakes by schedule",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewMedicationService(tt.store)
			ids, err := svc.ConfirmScheduleWithCleanup( 1, scheduledAt)

			if tt.wantErrContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Errorf("want error containing %q, got %v", tt.wantErrContains, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !equalIntSlice(ids, tt.wantReminderIDs) {
				t.Errorf("reminder IDs: got %v, want %v", ids, tt.wantReminderIDs)
			}
			if tt.wantDecrementedMedIDs != nil {
				if !equalInt64Slice(tt.store.decrementedMedIDs, tt.wantDecrementedMedIDs) {
					t.Errorf("decremented med IDs: got %v, want %v", tt.store.decrementedMedIDs, tt.wantDecrementedMedIDs)
				}
			}
		})
	}
}

func TestConfirmMedicationByMedID(t *testing.T) {
	takenAt := time.Now()

	tests := []struct {
		name               string
		store              *mockMedicationStore
		medID              int64
		wantReminderIDs    []int
		wantErr            error
		wantErrContains    string
		wantConfirmedID    int64
	}{
		{
			name:  "no pending intake returns ErrNotPending",
			medID: 42,
			store: &mockMedicationStore{
				getPendingIntakesFn: func() ([]store.IntakeLog, error) {
					return []store.IntakeLog{}, nil
				},
			},
			wantErr: ErrNotPending,
		},
		{
			name:  "store error propagated",
			medID: 42,
			store: &mockMedicationStore{
				getPendingIntakesFn: func() ([]store.IntakeLog, error) {
					return nil, errors.New("db error")
				},
			},
			wantErrContains: "get pending intakes",
		},
		{
			name:  "pending intake found and confirmed",
			medID: 10,
			store: &mockMedicationStore{
				getPendingIntakesFn: func() ([]store.IntakeLog, error) {
					return []store.IntakeLog{
						{ID: 5, MedicationID: 10, UserID: 1, Status: "PENDING"},
					}, nil
				},
				getIntakeFn: func(id int64) (*store.IntakeLog, error) {
					if id == 5 {
						return &store.IntakeLog{ID: 5, MedicationID: 10, UserID: 1, Status: "PENDING"}, nil
					}
					return nil, nil
				},
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) {
					return []int{101, 102}, nil
				},
				confirmIntakeFn: func(id int64, takenAt time.Time) error { return nil },
			},
			wantReminderIDs: []int{101, 102},
			wantConfirmedID: 5,
		},
		{
			name:  "first pending intake used when multiple exist",
			medID: 10,
			store: &mockMedicationStore{
				getPendingIntakesFn: func() ([]store.IntakeLog, error) {
					return []store.IntakeLog{
						{ID: 5, MedicationID: 10, UserID: 1, Status: "PENDING"},
						{ID: 6, MedicationID: 10, UserID: 1, Status: "PENDING"},
					}, nil
				},
				getIntakeFn: func(id int64) (*store.IntakeLog, error) {
					return &store.IntakeLog{ID: id, MedicationID: 10, UserID: 1, Status: "PENDING"}, nil
				},
				getIntakeRemindersFn: func(intakeID int64) ([]int, error) {
					return []int{200}, nil
				},
				confirmIntakeFn: func(id int64, takenAt time.Time) error { return nil },
			},
			wantReminderIDs: []int{200},
			wantConfirmedID: 5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewMedicationService(tt.store)
			ids, _, _, _, err := svc.ConfirmMedicationByMedID(tt.medID, takenAt)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("want error %v, got %v", tt.wantErr, err)
				}
				return
			}
			if tt.wantErrContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrContains) {
					t.Errorf("want error containing %q, got %v", tt.wantErrContains, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !equalIntSlice(ids, tt.wantReminderIDs) {
				t.Errorf("reminder IDs: got %v, want %v", ids, tt.wantReminderIDs)
			}
			if tt.wantConfirmedID != 0 && tt.store.lastConfirmedID != tt.wantConfirmedID {
				t.Errorf("ConfirmIntake called with id %d, want %d", tt.store.lastConfirmedID, tt.wantConfirmedID)
			}
		})
	}
}

// equalIntSlice returns true if both slices have the same elements in the same order.
func equalIntSlice(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// equalInt64Slice returns true if both slices have the same elements in the same order.
func equalInt64Slice(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
