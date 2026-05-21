package vitals

import (
	"context"
	"testing"
	"time"
)

func TestLatestHeartSample_Empty(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()

	ts, ok, err := r.LatestHeartSample(ctx, 999)
	if err != nil {
		t.Fatalf("LatestHeartSample: %v", err)
	}
	if ok {
		t.Errorf("expected found=false on empty table, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time on empty table, got %v", ts)
	}
}

func TestLatestHeartSample_ReturnsMax(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()
	userID := int64(7)

	t1 := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 10, 9, 15, 0, 0, time.UTC)
	t3 := time.Date(2026, 1, 10, 11, 30, 0, 0, time.UTC)

	logs := []VitalsHeartLog{
		{DateTime: t1, Value: 60, Type: 0},
		{DateTime: t3, Value: 75, Type: 0},
		{DateTime: t2, Value: 70, Type: 0},
	}
	if _, _, err := r.ImportVitals(ctx, userID, logs, nil, nil); err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	ts, ok, err := r.LatestHeartSample(ctx, userID)
	if err != nil {
		t.Fatalf("LatestHeartSample: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after import")
	}
	if !ts.Equal(t3) {
		t.Errorf("expected max=%v, got %v", t3, ts)
	}
}

func TestLatestHeartSample_IsolatesPerUser(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()

	tA := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	tB := time.Date(2026, 2, 1, 8, 0, 0, 0, time.UTC)

	if _, _, err := r.ImportVitals(ctx, 1, []VitalsHeartLog{{DateTime: tB, Value: 60}}, nil, nil); err != nil {
		t.Fatalf("import user 1: %v", err)
	}
	if _, _, err := r.ImportVitals(ctx, 2, []VitalsHeartLog{{DateTime: tA, Value: 60}}, nil, nil); err != nil {
		t.Fatalf("import user 2: %v", err)
	}

	ts, ok, err := r.LatestHeartSample(ctx, 2)
	if err != nil || !ok {
		t.Fatalf("user 2 latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(tA) {
		t.Errorf("user 2 should see only its own data; expected %v, got %v", tA, ts)
	}
}

func TestLatestSpO2Sample(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()

	t1 := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)

	if _, ok, err := r.LatestSpO2Sample(ctx, 5); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v", ok, err)
	}

	if _, _, err := r.ImportVitals(ctx, 5, nil, []VitalsSpO2Log{
		{DateTime: t1, Value: 97}, {DateTime: t2, Value: 96},
	}, nil); err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	ts, ok, err := r.LatestSpO2Sample(ctx, 5)
	if err != nil || !ok {
		t.Fatalf("after import: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(t2) {
		t.Errorf("expected %v, got %v", t2, ts)
	}
}

func TestLatestStressSample(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()

	t1 := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 10, 18, 0, 0, 0, time.UTC)

	if _, _, err := r.ImportVitals(ctx, 5, nil, nil, []VitalsStressLog{
		{DateTime: t1, Value: 30}, {DateTime: t2, Value: 60},
	}); err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	ts, ok, err := r.LatestStressSample(ctx, 5)
	if err != nil || !ok {
		t.Fatalf("after import: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(t2) {
		t.Errorf("expected %v, got %v", t2, ts)
	}
}

func TestLatestSleepEnd(t *testing.T) {
	r := setupVitalsRepo(t)
	ctx := context.Background()
	userID := int64(11)

	if _, ok, err := r.LatestSleepEnd(ctx, userID); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v", ok, err)
	}

	logs := []SleepLog{
		{
			StartTime: time.Date(2026, 1, 10, 23, 0, 0, 0, time.UTC),
			EndTime:   time.Date(2026, 1, 11, 7, 0, 0, 0, time.UTC),
			Day:       "2026-01-10",
		},
		{
			StartTime: time.Date(2026, 1, 11, 23, 30, 0, 0, time.UTC),
			EndTime:   time.Date(2026, 1, 12, 6, 30, 0, 0, time.UTC),
			Day:       "2026-01-11",
		},
	}
	if _, _, err := r.ImportSleepLogs(ctx, userID, logs); err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	ts, ok, err := r.LatestSleepEnd(ctx, userID)
	if err != nil {
		t.Fatalf("LatestSleepEnd: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after import")
	}
	want := time.Date(2026, 1, 12, 6, 30, 0, 0, time.UTC)
	if !ts.Equal(want) {
		t.Errorf("expected %v, got %v", want, ts)
	}
}
