package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func setupCardiovascularTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()

	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}

	audit := NewAuditBuffer("", "")
	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       123456,
		},
		data:  newStoreAdapter(st),
		audit: audit,
	}

	return s, st
}

func TestAnalyzeCardiovascular_AllDomains(t *testing.T) {
	s, st := setupCardiovascularTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	// Enable features
	if err := st.Settings.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	if err := st.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	// Add BP reading
	if _, err := st.BP.CreateReading(ctx, &store.BloodPressure{
		UserID:     userID,
		Systolic:   120,
		Diastolic:  80,
		MeasuredAt: time.Date(2026, 3, 15, 9, 0, 0, 0, time.Local),
		Category:   "Normal",
	}); err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	// Add medication
	if _, err := st.Medication.Create("Lisinopril", "10mg", "09:00", nil, nil, "", "", "flexible"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Add sleep log
	totalMin := 420
	deepMin := 90
	sleepLogs := []store.SleepLog{{
		UserID:       userID,
		StartTime:    time.Date(2026, 3, 14, 23, 0, 0, 0, time.Local),
		EndTime:      time.Date(2026, 3, 15, 6, 0, 0, 0, time.Local),
		TotalMinutes: &totalMin,
		DeepMinutes:  &deepMin,
	}}
	if _, _, err := st.Vitals.ImportSleepLogs(ctx, userID, sleepLogs); err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	// Add heart rate data
	heartLogs := []store.VitalsHeartLog{
		{UserID: userID, DateTime: time.Date(2026, 3, 15, 8, 0, 0, 0, time.UTC), Value: 65, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC), Value: 85, Type: 1},
	}
	spo2Logs := []store.VitalsSpO2Log{
		{UserID: userID, DateTime: time.Date(2026, 3, 15, 8, 0, 0, 0, time.UTC), Value: 97, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC), Value: 99, Type: 1},
	}
	if _, _, err := st.Vitals.ImportVitals(ctx, userID, heartLogs, spo2Logs, nil); err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	// Add diary note (created with current timestamp)
	if _, err := st.Diary.Create(ctx, userID, "started new medication today", nil); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	now := time.Now()
	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeCardiovascularInput{
		StartDate: "2026-03-14",
		EndDate:   now.AddDate(0, 0, 1).Format("2006-01-02"),
	}

	_, resp, err := s.handleAnalyzeCardiovascular(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeCardiovascular: %v", err)
	}

	// BP section
	if resp.BloodPressure == nil {
		t.Fatal("expected blood_pressure section to be present")
	}
	if len(resp.BloodPressure.Readings) != 1 {
		t.Errorf("expected 1 BP reading, got %d", len(resp.BloodPressure.Readings))
	}
	if resp.BloodPressure.AvgSystolic != 120 {
		t.Errorf("expected avg systolic 120, got %d", resp.BloodPressure.AvgSystolic)
	}
	if resp.BloodPressure.DaysMeasured != 1 {
		t.Errorf("expected 1 day measured, got %d", resp.BloodPressure.DaysMeasured)
	}

	// Medications section
	if resp.Medications == nil {
		t.Fatal("expected medications section to be present")
	}
	if len(resp.Medications.Active) != 1 {
		t.Errorf("expected 1 active medication, got %d", len(resp.Medications.Active))
	}
	if resp.Medications.Active[0].Name != "Lisinopril" {
		t.Errorf("expected Lisinopril, got %s", resp.Medications.Active[0].Name)
	}

	// Sleep section
	if resp.Sleep == nil {
		t.Fatal("expected sleep section to be present")
	}
	if len(resp.Sleep.Logs) != 1 {
		t.Errorf("expected 1 sleep log, got %d", len(resp.Sleep.Logs))
	}
	if resp.Sleep.AvgDurationMin != 420 {
		t.Errorf("expected avg duration 420, got %d", resp.Sleep.AvgDurationMin)
	}

	// Heart rate section
	if resp.HeartRate == nil {
		t.Fatal("expected heart_rate section to be present")
	}
	if resp.HeartRate.ReadingsCount != 2 {
		t.Errorf("expected 2 heart rate readings, got %d", resp.HeartRate.ReadingsCount)
	}
	if resp.HeartRate.Avg != 75 {
		t.Errorf("expected avg heart rate 75, got %d", resp.HeartRate.Avg)
	}
	if resp.HeartRate.Min != 65 {
		t.Errorf("expected min heart rate 65, got %d", resp.HeartRate.Min)
	}
	if resp.HeartRate.Max != 85 {
		t.Errorf("expected max heart rate 85, got %d", resp.HeartRate.Max)
	}

	// SpO2 section
	if resp.SpO2 == nil {
		t.Fatal("expected spo2 section to be present")
	}
	if resp.SpO2.ReadingsCount != 2 {
		t.Errorf("expected 2 SpO2 readings, got %d", resp.SpO2.ReadingsCount)
	}
	if resp.SpO2.Avg != 98 {
		t.Errorf("expected avg SpO2 98, got %d", resp.SpO2.Avg)
	}
	if resp.SpO2.Min != 97 {
		t.Errorf("expected min SpO2 97, got %d", resp.SpO2.Min)
	}

	// Diary notes
	if len(resp.DiaryNotes) != 1 {
		t.Errorf("expected 1 diary note, got %d", len(resp.DiaryNotes))
	}

	// Period should contain start date
	if resp.Period == "" {
		t.Error("expected non-empty period")
	}
}

func TestAnalyzeCardiovascular_BPDisabledOmitsSection(t *testing.T) {
	s, st := setupCardiovascularTestServer(t)
	defer st.Close()

	ctx := context.Background()

	// Disable BP explicitly
	if err := st.Settings.SetBloodPressureEnabled(ctx, false); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	// Enable medication
	if err := st.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeCardiovascularInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, resp, err := s.handleAnalyzeCardiovascular(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeCardiovascular: %v", err)
	}

	if resp.BloodPressure != nil {
		t.Error("expected blood_pressure section to be omitted when BP is disabled")
	}

	// Medications should still be present
	if resp.Medications == nil {
		t.Error("expected medications section to be present")
	}

	// Warning should mention unavailable sections
	if resp.Warning == "" {
		t.Error("expected warning about unavailable sections")
	}
}

func TestAnalyzeCardiovascular_EmptyDateRange(t *testing.T) {
	s, st := setupCardiovascularTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if err := st.Settings.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	if err := st.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeCardiovascularInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, resp, err := s.handleAnalyzeCardiovascular(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeCardiovascular: %v", err)
	}

	// All sections should be present but empty
	if resp.BloodPressure == nil {
		t.Error("expected blood_pressure section to be present (even if empty)")
	} else if len(resp.BloodPressure.Readings) != 0 {
		t.Errorf("expected 0 BP readings, got %d", len(resp.BloodPressure.Readings))
	}

	if resp.Medications == nil {
		t.Error("expected medications section to be present")
	}

	if resp.Sleep == nil {
		t.Error("expected sleep section to be present")
	}

	// HeartRate and SpO2 return nil when no data (consistent with other sections)
	if resp.HeartRate != nil {
		t.Error("expected heart_rate section to be nil when no data")
	}

	if resp.SpO2 != nil {
		t.Error("expected spo2 section to be nil when no data")
	}
}

func TestAnalyzeCardiovascular_DaysShorthand(t *testing.T) {
	s, st := setupCardiovascularTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if err := st.Settings.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	if err := st.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeCardiovascularInput{
		EndDate: "2026-03-16",
		Days:    7,
	}

	_, resp, err := s.handleAnalyzeCardiovascular(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeCardiovascular: %v", err)
	}

	if resp.Period != "2026-03-10 to 2026-03-16" {
		t.Errorf("expected period 2026-03-10 to 2026-03-16, got %s", resp.Period)
	}
}

func TestAnalyzeCardiovascular_AuditLogging(t *testing.T) {
	s, st := setupCardiovascularTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if err := st.Settings.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	if err := st.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeCardiovascularInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, _, err := s.handleAnalyzeCardiovascular(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeCardiovascular: %v", err)
	}

	// Check audit events
	s.audit.mu.Lock()
	defer s.audit.mu.Unlock()

	found := false
	for _, ev := range s.audit.events {
		if ev.DataType == "CardiovascularAnalysis" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected audit event for CardiovascularAnalysis")
	}
}
