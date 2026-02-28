package domain

import (
	"strings"
	"testing"
	"time"
)

func TestGenerateMedicationCSV(t *testing.T) {
	now := time.Date(2024, 1, 15, 9, 0, 0, 0, time.UTC)
	taken := time.Date(2024, 1, 15, 9, 5, 0, 0, time.UTC)

	intakes := []MedicationIntake{
		{ScheduledAt: now, TakenAt: &taken, MedicationName: "Aspirin", MedicationDosage: "100mg"},
		{ScheduledAt: now, TakenAt: nil, MedicationName: "Vitamin D", MedicationDosage: "1000IU"},
	}

	data, err := GenerateMedicationCSV(intakes)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	csv := string(data)
	if !strings.Contains(csv, "date time,medicine name,dosage") {
		t.Error("missing header")
	}
	if !strings.Contains(csv, "2024-01-15 09:05,Aspirin,100mg") {
		t.Error("expected taken_at time for first record")
	}
	if !strings.Contains(csv, "2024-01-15 09:00,Vitamin D,1000IU") {
		t.Error("expected scheduled_at time for second record (no taken_at)")
	}
}

func TestGenerateMedicationCSVEmpty(t *testing.T) {
	data, err := GenerateMedicationCSV(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(string(data), "date time") {
		t.Error("expected header even for empty data")
	}
}

func TestGenerateBPCSV(t *testing.T) {
	pulse := 72
	readings := []BPExportReading{
		{MeasuredAt: time.Date(2024, 1, 15, 9, 0, 0, 0, time.UTC), Systolic: 120, Diastolic: 80, Pulse: &pulse, Category: "Normal"},
		{MeasuredAt: time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC), Systolic: 140, Diastolic: 90, Pulse: nil, Category: ""},
	}

	data, err := GenerateBPCSV(readings)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	csv := string(data)
	if !strings.Contains(csv, "systolic") {
		t.Error("missing header")
	}
	if !strings.Contains(csv, "120,80,72,Normal") {
		t.Error("missing first record")
	}
	// Second record should get auto-calculated category
	if !strings.Contains(csv, "High BP Stage 2") {
		t.Error("expected auto-calculated category for second record")
	}
}

func TestGenerateWeightCSV(t *testing.T) {
	trend := 75.0
	logs := []WeightExportLog{
		{MeasuredAt: time.Date(2024, 1, 15, 9, 0, 0, 0, time.UTC), Weight: 75.5, WeightTrend: &trend, Notes: "morning"},
	}

	data, err := GenerateWeightCSV(logs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	csv := string(data)
	if !strings.Contains(csv, "#Version: 6") {
		t.Error("missing Libra header")
	}
	if !strings.Contains(csv, "75.5") {
		t.Error("missing weight value")
	}
	if !strings.Contains(csv, "75.0") {
		t.Error("missing trend value")
	}
}
