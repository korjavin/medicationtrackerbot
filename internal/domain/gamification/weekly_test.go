package gamification

// weekly_test.go is the Task 1 integration test (gamification-12, Testing
// Strategy): a real service over seeded fakes, two weeks with a known
// difference in ledger + weight data, exercising the lever/best-day/gauge/
// Health Score contract plus the "quiet week" empty-week shape.

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// TestGetWeeklyReview_TwoWeeksKnownDifference seeds last week with the
// Movement ring closed 2 days and this week with it closed 5 days (a known
// improvement), plus a declining weight series so the weight gauge reads a
// real trend. It asserts: lever counts this week vs last, best day picks the
// day with the most rings closed, and the review is not "quiet" (it has HP).
func TestGetWeeklyReview_TwoWeeksKnownDifference(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 201
	// A Sunday, so weekBounds/weekIndex land on a clean week boundary.
	today := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)
	if !isWeekEndDay(today) {
		t.Fatalf("test fixture bug: %v is not a week-end day", today)
	}
	thisWeekStart := today.AddDate(0, 0, -6)
	lastWeekStart := thisWeekStart.AddDate(0, 0, -7)

	gam := newMemGam()
	var ledger []gamstore.LedgerEntry
	// Last week: Movement closes on 2 days.
	for i := 0; i < 2; i++ {
		ledger = append(ledger, gamstore.LedgerEntry{
			UserID: userID, Day: lastWeekStart.AddDate(0, 0, i),
			Ring: scoring.RingMovement, Kind: scoring.KindOutcome, HP: 10,
		})
	}
	// This week: Movement closes on 5 days; the 3rd day also closes
	// Nourishment, making it the best day (2 rings closed).
	for i := 0; i < 5; i++ {
		day := thisWeekStart.AddDate(0, 0, i)
		ledger = append(ledger, gamstore.LedgerEntry{
			UserID: userID, Day: day,
			Ring: scoring.RingMovement, Kind: scoring.KindOutcome, HP: 10,
		})
		if i == 2 {
			ledger = append(ledger, gamstore.LedgerEntry{
				UserID: userID, Day: day,
				Ring: scoring.RingNourishment, Kind: scoring.KindOutcome, HP: 10,
			})
		}
	}
	if err := gam.UpsertLedger(ctx, userID, ledger); err != nil {
		t.Fatalf("seed ledger: %v", err)
	}

	// A declining weight series across both weeks, well past the EMA's
	// convergence time, so the weight gauge reads a real (non-insufficient)
	// trend for both anchors.
	const days = 40
	const startWeight = 90.0
	const declinePerDay = startWeight * 0.0065 / 7
	logs := make([]store.WeightLog, 0, days)
	for i := 0; i < days; i++ {
		day := today.AddDate(0, 0, -(days - 1 - i))
		logs = append(logs, store.WeightLog{
			MeasuredAt: day.Add(7 * time.Hour),
			Weight:     startWeight - declinePerDay*float64(i),
		})
	}

	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		weight:   fakeWeight{logs: logs},
		gam:      gam,
	})
	svc.now = func() time.Time { return today }

	review, err := svc.GetWeeklyReview(ctx, userID, today)
	if err != nil {
		t.Fatalf("GetWeeklyReview: %v", err)
	}
	if !review.Enabled {
		t.Fatalf("Enabled = false, want true")
	}
	if review.Quiet {
		t.Errorf("Quiet = true, want false (week has HP)")
	}

	var movement, nourishment *WeeklyLeverReview
	for i := range review.Levers {
		switch review.Levers[i].Key {
		case LeverMovement:
			movement = &review.Levers[i]
		case LeverNourishment:
			nourishment = &review.Levers[i]
		}
	}
	if movement == nil {
		t.Fatalf("no Movement lever in review")
	}
	if movement.ClosedThisWeek != 5 || movement.ClosedLastWeek != 2 {
		t.Errorf("Movement closed = this:%d last:%d, want this:5 last:2", movement.ClosedThisWeek, movement.ClosedLastWeek)
	}
	if nourishment == nil {
		t.Fatalf("no Nourishment lever in review")
	}
	if nourishment.ClosedThisWeek != 1 || nourishment.ClosedLastWeek != 0 {
		t.Errorf("Nourishment closed = this:%d last:%d, want this:1 last:0", nourishment.ClosedThisWeek, nourishment.ClosedLastWeek)
	}

	if review.BestDay == nil {
		t.Fatalf("BestDay = nil, want the day with 2 rings closed")
	}
	wantBestDay := thisWeekStart.AddDate(0, 0, 2).Unix()
	if review.BestDay.DayUnix != wantBestDay || review.BestDay.RingsClosed != 2 {
		t.Errorf("BestDay = {%d, %d}, want {%d, 2}", review.BestDay.DayUnix, review.BestDay.RingsClosed, wantBestDay)
	}

	if review.DaysWithAnyHP != 5 {
		t.Errorf("DaysWithAnyHP = %d, want 5", review.DaysWithAnyHP)
	}

	if review.Gauges.Weight.Status != GaugeStatusOK {
		t.Errorf("weight gauge status = %q, want ok", review.Gauges.Weight.Status)
	}
	if review.Gauges.Weight.VelocityPctPerWeek >= 0 {
		t.Errorf("weight velocity = %v, want negative (losing trend)", review.Gauges.Weight.VelocityPctPerWeek)
	}
}

// TestGetWeeklyReview_QuietWeek asserts the empty-week semantics: a user with
// zero ledger HP in the reviewed week gets a valid, non-error review shaped
// with Quiet:true, not a wall of zeros treated as an error.
func TestGetWeeklyReview_QuietWeek(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 202
	today := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)

	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}})
	svc.now = func() time.Time { return today }

	review, err := svc.GetWeeklyReview(ctx, userID, today)
	if err != nil {
		t.Fatalf("GetWeeklyReview: %v", err)
	}
	if !review.Enabled {
		t.Fatalf("Enabled = false, want true")
	}
	if !review.Quiet {
		t.Errorf("Quiet = false, want true (no ledger HP this week)")
	}
	if review.BestDay != nil {
		t.Errorf("BestDay = %+v, want nil on a quiet week", review.BestDay)
	}
	if review.DaysWithAnyHP != 0 {
		t.Errorf("DaysWithAnyHP = %d, want 0", review.DaysWithAnyHP)
	}
}

// TestGetWeeklyReview_GateOff asserts the disabled-flag shape: {Enabled:false}
// with no ledger/gauge reads attempted.
func TestGetWeeklyReview_GateOff(t *testing.T) {
	ctx := context.Background()
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: false}})

	review, err := svc.GetWeeklyReview(ctx, 203, time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetWeeklyReview: %v", err)
	}
	if review.Enabled {
		t.Errorf("Enabled = true, want false (gate off)")
	}
}
