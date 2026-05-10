package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func setupVitalsMCPTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()

	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}

	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       123456,
		},
		data: st,
	}

	return s, st
}

func TestHandleGetVitalsHeart_HappyPath(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)
	tzOffset := 0

	// Create some dummy data
	heartLogs := []store.VitalsHeartLog{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 70, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 9, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 75, Type: 1},
	}

	_, _, err := st.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("failed to import vitals: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	res, resp, err := s.handleGetVitalsHeart(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != nil {
		t.Errorf("expected CallToolResult to be nil")
	}

	if resp.Count != 2 {
		t.Errorf("expected count to be 2, got %d", resp.Count)
	}

	logs, ok := resp.Logs.([]HeartRateResult)
	if !ok {
		t.Fatalf("expected Logs to be []HeartRateResult")
	}

	if len(logs) != 2 {
		t.Errorf("expected 2 logs, got %d", len(logs))
	}

	if logs[0].Value != 70 || logs[1].Value != 75 {
		t.Errorf("unexpected log values: %+v", logs)
	}
}

func TestHandleGetVitalsHeart_Empty(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	_, resp, err := s.handleGetVitalsHeart(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected count to be 0, got %d", resp.Count)
	}
}

func TestHandleGetVitalsSpO2_HappyPath(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)
	tzOffset := 0

	// Create some dummy data
	spo2Logs := []store.VitalsSpO2Log{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 98, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 9, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 99, Type: 1},
	}

	_, _, err := st.ImportVitals(ctx, userID, nil, spo2Logs, nil)
	if err != nil {
		t.Fatalf("failed to import vitals: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	res, resp, err := s.handleGetVitalsSpO2(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != nil {
		t.Errorf("expected CallToolResult to be nil")
	}

	if resp.Count != 2 {
		t.Errorf("expected count to be 2, got %d", resp.Count)
	}

	logs, ok := resp.Logs.([]SpO2Result)
	if !ok {
		t.Fatalf("expected Logs to be []SpO2Result")
	}

	if len(logs) != 2 {
		t.Errorf("expected 2 logs, got %d", len(logs))
	}

	if logs[0].Value != 98 || logs[1].Value != 99 {
		t.Errorf("unexpected log values: %+v", logs)
	}
}

func TestHandleGetVitalsSpO2_Empty(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	_, resp, err := s.handleGetVitalsSpO2(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected count to be 0, got %d", resp.Count)
	}
}

func TestHandleGetVitalsStress_HappyPath(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)
	tzOffset := 0

	// Create some dummy data
	stressLogs := []store.VitalsStressLog{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 30, Type: 1, Info: "Rest"},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 9, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 80, Type: 1, Info: "High Stress"},
	}

	_, _, err := st.ImportVitals(ctx, userID, nil, nil, stressLogs)
	if err != nil {
		t.Fatalf("failed to import vitals: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	res, resp, err := s.handleGetVitalsStress(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != nil {
		t.Errorf("expected CallToolResult to be nil")
	}

	if resp.Count != 2 {
		t.Errorf("expected count to be 2, got %d", resp.Count)
	}

	logs, ok := resp.Logs.([]StressResult)
	if !ok {
		t.Fatalf("expected Logs to be []StressResult")
	}

	if len(logs) != 2 {
		t.Errorf("expected 2 logs, got %d", len(logs))
	}

	if logs[0].Value != 30 || logs[1].Value != 80 {
		t.Errorf("unexpected log values: %+v", logs)
	}
}

func TestHandleGetVitalsStress_Empty(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	_, resp, err := s.handleGetVitalsStress(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected count to be 0, got %d", resp.Count)
	}
}

func TestHandleGetHealthOverview(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)
	tzOffset := 0

	// Create some dummy data
	heartLogs := []store.VitalsHeartLog{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 70, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 9, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 90, Type: 1},
	}
	spo2Logs := []store.VitalsSpO2Log{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 98, Type: 1},
	}
	stressLogs := []store.VitalsStressLog{
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 8, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 20, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 9, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 30, Type: 1},
		{UserID: userID, DateTime: time.Date(2026, 2, 18, 10, 30, 0, 0, time.UTC), TzOffset: tzOffset, Value: 40, Type: 1},
	}

	_, _, err := st.ImportVitals(ctx, userID, heartLogs, spo2Logs, stressLogs)
	if err != nil {
		t.Fatalf("failed to import vitals: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-18",
	}

	res, resp, err := s.handleGetHealthOverview(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != nil {
		t.Errorf("expected CallToolResult to be nil")
	}

	if resp.CountHeart != 2 {
		t.Errorf("expected 2 heart logs, got %d", resp.CountHeart)
	}
	if resp.CountSpO2 != 1 {
		t.Errorf("expected 1 spo2 log, got %d", resp.CountSpO2)
	}
	if resp.CountStress != 3 {
		t.Errorf("expected 3 stress logs, got %d", resp.CountStress)
	}

	if resp.AverageHeartRate != 80 {
		t.Errorf("expected average heart rate 80, got %d", resp.AverageHeartRate)
	}
	if resp.AverageSpO2 != 98 {
		t.Errorf("expected average spo2 98, got %d", resp.AverageSpO2)
	}
	if resp.AverageStress != 30 {
		t.Errorf("expected average stress 30, got %d", resp.AverageStress)
	}
}

func TestHandleGetVitalsHeart_Truncation(t *testing.T) {
	s, st := setupVitalsMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)
	tzOffset := 0

	// Create 1500 dummy entries to trigger truncation (limit is 1440)
	var heartLogs []store.VitalsHeartLog
	baseTime := time.Date(2026, 2, 18, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 1500; i++ {
		heartLogs = append(heartLogs, store.VitalsHeartLog{
			UserID:   userID,
			DateTime: baseTime.Add(time.Duration(i) * time.Minute),
			TzOffset: tzOffset,
			Value:    70 + (i % 30),
			Type:     1,
		})
	}

	_, _, err := st.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("failed to import vitals: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	// parseDateRange interprets these as 00:00 / 23:59 in the test runner's
	// local timezone, so we widen the window to comfortably cover the entries
	// (which span ~25h starting at 2026-02-18 00:00 UTC) regardless of TZ.
	// The truncation under test is purely about exceeding the 1440 cap, so
	// the exact window edges don't matter as long as all 1500 fixtures fit.
	input := DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-20",
	}

	res, resp, err := s.handleGetVitalsHeart(ctx, req, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != nil {
		t.Errorf("expected CallToolResult to be nil")
	}

	if resp.Count != 1440 {
		t.Errorf("expected count to be truncated to 1440, got %d", resp.Count)
	}

	logs, ok := resp.Logs.([]HeartRateResult)
	if !ok {
		t.Fatalf("expected Logs to be []HeartRateResult")
	}

	if len(logs) != 1440 {
		t.Errorf("expected 1440 logs, got %d", len(logs))
	}

	// Verify that the warning message contains the truncation text
	if resp.Warning == "" {
		t.Errorf("expected warning message about truncation")
	} else if len(resp.Warning) < 10 {
		t.Errorf("warning message seems too short: %s", resp.Warning)
	}
}
