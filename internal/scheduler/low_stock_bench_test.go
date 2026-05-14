package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockMedStoreForBench struct {
	MedicationStore
	meds []store.Medication
}

func (m *mockMedStoreForBench) GetMedicationsLowOnStock(days int) ([]store.Medication, error) {
	return m.meds, nil
}

func (m *mockMedStoreForBench) GetDaysOfStockRemaining(med *store.Medication) *float64 {
	d := float64(5.0)
	return &d
}

func (m *mockMedStoreForBench) GetCurrentTimezone() (string, error) {
	// Pin to UTC so the benchmark exercises the same code path on every
	// host: empty TZ would fall back to time.Local, and on a non-UTC
	// machine the fixed 11:00 UTC clock would no longer satisfy the
	// hour gate and the bench would measure the no-op path.
	return "UTC", nil
}

func BenchmarkLowStockChecker(b *testing.B) {
	// Create a large number of dummy medications
	meds := make([]store.Medication, 1000)
	for i := range meds {
		count := 10
		meds[i] = store.Medication{
			ID:             int64(i + 1),
			Name:           "TestMed",
			InventoryCount: &count,
		}
	}

	mockStore := &mockMedStoreForBench{meds: meds}
	checker := &LowStockChecker{
		store: mockStore,
		now: func() time.Time {
			return time.Date(2023, 1, 1, 11, 0, 0, 0, time.UTC)
		},
	}
	checker.notifiers = nil

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		checker.lastCheck = time.Time{} // Force check every loop
		checker.Check(context.Background())
	}
}
