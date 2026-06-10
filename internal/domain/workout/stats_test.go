package workout

import (
	"errors"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeStatsStore drives GetStats: only ListHistory + ListExerciseStats are
// exercised; everything else falls through to the embedded no-op base.
type fakeStatsStore struct {
	noopWorkoutStore

	history    []store.WorkoutSession
	historyErr error

	exerciseStats []store.ExerciseStat
	exStatsErr    error
}

func (f *fakeStatsStore) ListHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return f.history, f.historyErr
}
func (f *fakeStatsStore) ListExerciseStats(userID int64) ([]store.ExerciseStat, error) {
	return f.exerciseStats, f.exStatsErr
}

func statsSvcAt(f *fakeStatsStore, now time.Time) *Service {
	svc := New(f, nil)
	svc.Now = func() time.Time { return now }
	return svc
}

func sessAt(date string, status string) store.WorkoutSession {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		panic(err)
	}
	// Anchor at noon UTC so comparisons against the noon-anchored window
	// cutoffs in the tests are unambiguous.
	d = d.Add(12 * time.Hour)
	return store.WorkoutSession{ScheduledDate: d, Status: status}
}

func TestGetStats_ZeroSessions(t *testing.T) {
	f := &fakeStatsStore{} // no history, no exercise stats
	now := time.Date(2030, 7, 1, 12, 0, 0, 0, time.UTC)
	stats, err := statsSvcAt(f, now).GetStats(123)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.TotalSessions != 0 || stats.CompletedSessions != 0 || stats.SkippedSessions != 0 {
		t.Errorf("counts: want all 0, got %d/%d/%d", stats.TotalSessions, stats.CompletedSessions, stats.SkippedSessions)
	}
	if stats.CompletionRate != 0 {
		t.Errorf("completion_rate: want 0, got %v", stats.CompletionRate)
	}
	if stats.ActiveWeeks != 0 {
		t.Errorf("active_weeks: want 0, got %d", stats.ActiveWeeks)
	}
	// Empty heatmap must stay nil so it marshals to JSON null, matching the
	// legacy handler's `var weeklyActivity []WeekActivity` semantics.
	if stats.WeeklyActivity != nil {
		t.Errorf("weekly_activity: want nil (null), got %+v", stats.WeeklyActivity)
	}
	// No exercise stats → nil passthrough (also marshals to null).
	if stats.TopExercises != nil {
		t.Errorf("top_exercises: want nil, got %+v", stats.TopExercises)
	}
}

func TestGetStats_HistoryErrorPropagates(t *testing.T) {
	wantErr := errors.New("history read failed")
	f := &fakeStatsStore{historyErr: wantErr}
	now := time.Date(2030, 7, 1, 12, 0, 0, 0, time.UTC)
	stats, err := statsSvcAt(f, now).GetStats(123)
	if stats != nil {
		t.Fatalf("expected nil stats on error, got %+v", stats)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected history error to propagate, got %v", err)
	}
}

func TestGetStats_MixedStatuses30DayWindow(t *testing.T) {
	now := time.Date(2030, 7, 1, 12, 0, 0, 0, time.UTC) // since30 = 2030-06-01 12:00
	f := &fakeStatsStore{
		history: []store.WorkoutSession{
			sessAt("2030-06-20", "completed"), // in 30d → counts
			sessAt("2030-06-25", "completed"), // in 30d → counts
			sessAt("2030-06-22", "skipped"),   // in 30d → counts
			sessAt("2030-06-23", "started"),   // in 30d but non-terminal → ignored
			sessAt("2030-05-15", "completed"), // outside 30d → not counted in 30d totals
		},
	}
	stats, err := statsSvcAt(f, now).GetStats(123)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.TotalSessions != 3 {
		t.Errorf("total_sessions: want 3 (started ignored, 05-15 out of window), got %d", stats.TotalSessions)
	}
	if stats.CompletedSessions != 2 {
		t.Errorf("completed_sessions: want 2, got %d", stats.CompletedSessions)
	}
	if stats.SkippedSessions != 1 {
		t.Errorf("skipped_sessions: want 1, got %d", stats.SkippedSessions)
	}
	wantRate := float64(2) / float64(3) * 100
	if stats.CompletionRate != wantRate {
		t.Errorf("completion_rate: want %v, got %v", wantRate, stats.CompletionRate)
	}
}

func TestGetStats_WeeklyBucketingAcrossMonthBoundary(t *testing.T) {
	now := time.Date(2030, 7, 1, 12, 0, 0, 0, time.UTC) // cutoff12w = 2030-04-08 12:00
	f := &fakeStatsStore{
		history: []store.WorkoutSession{
			// Week of Mon 2030-05-27 spans the May/June boundary:
			sessAt("2030-05-31", "completed"), // Fri → monday 2030-05-27
			sessAt("2030-06-01", "skipped"),   // Sat → monday 2030-05-27
			// Week of Mon 2030-06-03:
			sessAt("2030-06-03", "completed"),
			sessAt("2030-06-05", "completed"),
			// Week of Mon 2030-06-17: only a skip (not "active").
			sessAt("2030-06-20", "skipped"),
		},
	}
	stats, err := statsSvcAt(f, now).GetStats(123)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []WeekActivity{
		{Week: "2030-05-27", Completed: 1, Skipped: 1},
		{Week: "2030-06-03", Completed: 2, Skipped: 0},
		{Week: "2030-06-17", Completed: 0, Skipped: 1},
	}
	if len(stats.WeeklyActivity) != len(want) {
		t.Fatalf("weekly_activity length: want %d, got %d (%+v)", len(want), len(stats.WeeklyActivity), stats.WeeklyActivity)
	}
	for i, wa := range want {
		got := stats.WeeklyActivity[i]
		if got != wa {
			t.Errorf("weekly_activity[%d]: want %+v, got %+v (must be chronologically sorted)", i, wa, got)
		}
	}
	// active_weeks counts weeks with at least one completion: 05-27 and 06-03.
	if stats.ActiveWeeks != 2 {
		t.Errorf("active_weeks: want 2 (skip-only week excluded), got %d", stats.ActiveWeeks)
	}
}

func TestGetStats_TopExercisesPassthroughAndErrorSwallowed(t *testing.T) {
	now := time.Date(2030, 7, 1, 12, 0, 0, 0, time.UTC)

	// Passthrough: whatever ListExerciseStats returns becomes top_exercises.
	top := []store.ExerciseStat{{ExerciseName: "Bench", SessionCount: 5, TotalVolumeKg: 1000, MaxWeightKg: 80}}
	f := &fakeStatsStore{exerciseStats: top}
	stats, err := statsSvcAt(f, now).GetStats(123)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stats.TopExercises) != 1 || stats.TopExercises[0].ExerciseName != "Bench" {
		t.Errorf("top_exercises passthrough failed, got %+v", stats.TopExercises)
	}

	// Error swallowed: a failed ListExerciseStats leaves top_exercises nil and
	// does NOT surface an error, matching the legacy `exerciseStats, _ := ...`.
	f2 := &fakeStatsStore{exStatsErr: errors.New("boom")}
	stats2, err2 := statsSvcAt(f2, now).GetStats(123)
	if err2 != nil {
		t.Fatalf("ListExerciseStats error must be swallowed, got %v", err2)
	}
	if stats2.TopExercises != nil {
		t.Errorf("top_exercises: want nil on read error, got %+v", stats2.TopExercises)
	}
}
