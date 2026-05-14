package store

import (
	"testing"
	"time"
)

// setupBenchStore is adapted from setupTestStore but accepts testing.TB
func setupBenchStore(tb testing.TB) *Store {
	db, err := New(":memory:")
	if err != nil {
		tb.Fatalf("failed to create store: %v", err)
	}
	tb.Cleanup(func() { db.Close() })
	return db
}

func BenchmarkAddIntakeReminder(b *testing.B) {
	db := setupBenchStore(b)

	medID, err := db.Medication.CreateMedication("BenchMed", "5mg", `{"type":"daily","times":["21:30"]}`, nil, nil, "", "", "")
	if err != nil {
		b.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Now()
	intakeID, err := db.Medication.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		b.Fatalf("CreateIntake failed: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := db.Medication.AddIntakeReminder(intakeID, i)
		if err != nil {
			b.Fatalf("AddIntakeReminder failed: %v", err)
		}
	}
}
