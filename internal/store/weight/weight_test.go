package weight

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// setupWeightRepo creates an in-memory DB with all migrations and a weight
// repo bound to it.
func setupWeightRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func float64Ptr(v float64) *float64 {
	return &v
}

func TestCreateLogAllFields(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	w := &WeightLog{
		UserID:          123,
		MeasuredAt:      now,
		Weight:          85.5,
		WeightTrend:     float64Ptr(85.0),
		BodyFat:         float64Ptr(18.5),
		BodyFatTrend:    float64Ptr(18.3),
		MuscleMass:      float64Ptr(40.2),
		MuscleMassTrend: float64Ptr(40.0),
		Notes:           "Morning measurement",
	}

	id, err := r.CreateLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}
	if id == 0 {
		t.Fatal("Expected non-zero ID")
	}
}

func TestCreateLogMinimal(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}

	id, err := r.CreateLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}
	if id == 0 {
		t.Fatal("Expected non-zero ID")
	}
}

func TestListLogsOrderedByDateDesc(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	for i := 0; i < 3; i++ {
		w := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     80.0 + float64(i),
		}
		if _, err := r.CreateLog(ctx, w); err != nil {
			t.Fatalf("CreateLog failed: %v", err)
		}
	}

	logs, err := r.ListLogs(ctx, 123, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("ListLogs failed: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("Expected 3 logs, got %d", len(logs))
	}

	// Should be DESC order: newest first
	if logs[0].Weight < logs[1].Weight || logs[1].Weight < logs[2].Weight {
		t.Errorf("Logs not in DESC order: %.1f, %.1f, %.1f", logs[0].Weight, logs[1].Weight, logs[2].Weight)
	}
}

func TestListLogsSinceFilter(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	for i := 0; i < 5; i++ {
		w := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     80.0 + float64(i),
		}
		if _, err := r.CreateLog(ctx, w); err != nil {
			t.Fatalf("CreateLog failed: %v", err)
		}
	}

	// Only get logs from day 3 onwards
	since := base.Add(2 * 24 * time.Hour)
	logs, err := r.ListLogs(ctx, 123, since)
	if err != nil {
		t.Fatalf("ListLogs failed: %v", err)
	}
	if len(logs) < 2 {
		t.Fatalf("Expected at least 2 logs since filter, got %d", len(logs))
	}
}

func TestDeleteLogSuccess(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}
	id, err := r.CreateLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}

	err = r.DeleteLog(ctx, id, 123)
	if err != nil {
		t.Fatalf("DeleteLog failed: %v", err)
	}
}

func TestDeleteLogWrongUser(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}
	id, err := r.CreateLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}

	err = r.DeleteLog(ctx, id, 999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Expected sql.ErrNoRows for wrong user, got: %v", err)
	}
}

func TestDeleteLogNotFound(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	err := r.DeleteLog(ctx, 99999, 123)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Expected sql.ErrNoRows for non-existent log, got: %v", err)
	}
}

func TestGetLastLogReturnsMostRecent(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	// Insert older entry
	w1 := &WeightLog{
		UserID:     123,
		MeasuredAt: base,
		Weight:     80.0,
	}
	if _, err := r.CreateLog(ctx, w1); err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}

	// Insert newer entry
	w2 := &WeightLog{
		UserID:     123,
		MeasuredAt: base.Add(48 * time.Hour),
		Weight:     81.5,
	}
	if _, err := r.CreateLog(ctx, w2); err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}

	last, err := r.GetLastLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetLastLog failed: %v", err)
	}
	if last == nil {
		t.Fatal("Expected non-nil result")
	}
	if last.Weight != 81.5 {
		t.Errorf("Expected weight 81.5, got %.1f", last.Weight)
	}
}

func TestGetLastLogEmpty(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	last, err := r.GetLastLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetLastLog failed: %v", err)
	}
	if last != nil {
		t.Fatalf("Expected nil for empty table, got %+v", last)
	}
}

func TestGetHighestLog(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	weights := []float64{80.0, 95.3, 82.1, 78.0}
	for i, w := range weights {
		log := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     w,
		}
		if _, err := r.CreateLog(ctx, log); err != nil {
			t.Fatalf("CreateLog failed: %v", err)
		}
	}

	highest, err := r.GetHighestLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetHighestLog failed: %v", err)
	}
	if highest == nil {
		t.Fatal("Expected non-nil result")
	}
	if highest.Weight != 95.3 {
		t.Errorf("Expected highest weight 95.3, got %.1f", highest.Weight)
	}
}

func TestGetHighestLogEmpty(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	highest, err := r.GetHighestLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetHighestLog failed: %v", err)
	}
	if highest != nil {
		t.Fatalf("Expected nil for empty table, got %+v", highest)
	}
}

func TestSetAndGetGoal(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	targetDate := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	err := r.SetGoal(ctx, 123, 75.0, targetDate)
	if err != nil {
		t.Fatalf("SetGoal failed: %v", err)
	}

	goal, err := r.GetGoal(ctx, 123)
	if err != nil {
		t.Fatalf("GetGoal failed: %v", err)
	}
	if goal == nil {
		t.Fatal("Expected non-nil goal")
	}
	if goal.Goal == nil {
		t.Fatal("Expected non-nil Goal value")
	}
	if *goal.Goal != 75.0 {
		t.Errorf("Expected goal weight 75.0, got %.1f", *goal.Goal)
	}
	if goal.GoalDate == nil {
		t.Fatal("Expected non-nil GoalDate")
	}
}

func TestGetGoalEmpty(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	goal, err := r.GetGoal(ctx, 123)
	if err != nil {
		t.Fatalf("GetGoal failed: %v", err)
	}
	if goal == nil {
		t.Fatal("Expected non-nil WeightGoal (empty struct)")
	}
	// Empty goal should have nil pointers
	if goal.Goal != nil {
		t.Errorf("Expected nil Goal for empty store, got %v", *goal.Goal)
	}
}

// insertGoalHistory inserts a row directly into weight_goals. Used by the
// history-aware GetGoal/ListGoals tests so they don't depend on the SetGoal
// rewrite (Task 3) landing yet.
func insertGoalHistory(t *testing.T, r *Repo, userID int64, setAtUnix int64, target float64, targetDate string, startWeight *float64) {
	t.Helper()
	var sw interface{}
	if startWeight != nil {
		sw = *startWeight
	}
	if _, err := r.db.Exec(
		"INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight) VALUES (?, ?, ?, ?, ?)",
		userID, setAtUnix, target, targetDate, sw,
	); err != nil {
		t.Fatalf("insert weight_goals: %v", err)
	}
}

func TestGetGoal_ReadsLatestHistoryRow(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC).Unix()
	insertGoalHistory(t, r, 123, base, 80.0, "2026-04-01", float64Ptr(90.0))
	insertGoalHistory(t, r, 123, base+3600, 75.0, "2026-06-01", float64Ptr(88.5))

	goal, err := r.GetGoal(ctx, 123)
	if err != nil {
		t.Fatalf("GetGoal failed: %v", err)
	}
	if goal.Goal == nil || *goal.Goal != 75.0 {
		t.Errorf("Expected latest goal 75.0, got %+v", goal.Goal)
	}
	if goal.GoalDate == nil || goal.GoalDate.Format("2006-01-02") != "2026-06-01" {
		t.Errorf("Expected latest GoalDate 2026-06-01, got %+v", goal.GoalDate)
	}
	if goal.GoalSetAt == nil || goal.GoalSetAt.Unix() != base+3600 {
		t.Errorf("Expected GoalSetAt to match latest row, got %+v", goal.GoalSetAt)
	}
	if goal.GoalStartWeight == nil || *goal.GoalStartWeight != 88.5 {
		t.Errorf("Expected GoalStartWeight 88.5, got %+v", goal.GoalStartWeight)
	}
}

func TestGetGoal_FallsBackToSettingsWhenHistoryEmpty(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	// Simulate a pre-history legacy goal by writing directly to settings — we
	// can't go through SetGoal anymore because it now also inserts into
	// weight_goals, which would short-circuit the fallback path under test.
	if _, err := r.db.Exec(
		"UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1",
		70.0, "2026-07-01",
	); err != nil {
		t.Fatalf("seed legacy settings goal: %v", err)
	}

	// No row in weight_goals yet → fallback to settings.
	goal, err := r.GetGoal(ctx, 123)
	if err != nil {
		t.Fatalf("GetGoal failed: %v", err)
	}
	if goal.Goal == nil || *goal.Goal != 70.0 {
		t.Errorf("Expected legacy goal 70.0 via fallback, got %+v", goal.Goal)
	}
	if goal.GoalDate == nil {
		t.Fatal("Expected GoalDate via fallback")
	}
	if goal.GoalSetAt != nil || goal.GoalStartWeight != nil {
		t.Errorf("Expected snapshot fields nil on fallback, got setAt=%v startWeight=%v", goal.GoalSetAt, goal.GoalStartWeight)
	}
}

func TestGetGoal_PerUserIsolation(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC).Unix()
	insertGoalHistory(t, r, 111, now, 70.0, "2026-08-01", nil)
	insertGoalHistory(t, r, 222, now+10, 65.0, "2026-09-01", float64Ptr(72.3))

	g1, err := r.GetGoal(ctx, 111)
	if err != nil {
		t.Fatalf("GetGoal user 111: %v", err)
	}
	if g1.Goal == nil || *g1.Goal != 70.0 {
		t.Errorf("Expected user 111 goal 70.0, got %+v", g1.Goal)
	}
	if g1.GoalStartWeight != nil {
		t.Errorf("Expected user 111 GoalStartWeight nil, got %v", *g1.GoalStartWeight)
	}

	g2, err := r.GetGoal(ctx, 222)
	if err != nil {
		t.Fatalf("GetGoal user 222: %v", err)
	}
	if g2.Goal == nil || *g2.Goal != 65.0 {
		t.Errorf("Expected user 222 goal 65.0, got %+v", g2.Goal)
	}
	if g2.GoalStartWeight == nil || *g2.GoalStartWeight != 72.3 {
		t.Errorf("Expected user 222 GoalStartWeight 72.3, got %+v", g2.GoalStartWeight)
	}

	// A third user with no history and no legacy goal returns empty.
	g3, err := r.GetGoal(ctx, 999)
	if err != nil {
		t.Fatalf("GetGoal user 999: %v", err)
	}
	if g3 == nil {
		t.Fatal("Expected non-nil empty WeightGoal for unknown user")
	}
	if g3.Goal != nil {
		t.Errorf("Expected unknown user to have nil Goal, got %v", *g3.Goal)
	}
}

func TestGetGoal_NoLeakViaSettingsAfterAnotherUserSetGoal(t *testing.T) {
	// Regression: SetGoal dual-writes to the singleton settings.weight_goal
	// row. The legacy fallback in GetGoal must NOT return that singleton to a
	// different user with no weight_goals row of their own — doing so would
	// leak user A's health-goal data to user B.
	r := setupWeightRepo(t)
	ctx := context.Background()

	// User A saves a goal — this inserts a weight_goals row AND updates the
	// singleton settings.weight_goal{,_date} columns.
	if err := r.SetGoal(ctx, 111, 75.0, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("SetGoal user 111: %v", err)
	}

	// User B has no weight_goals row. GetGoal must return empty, not leak
	// user A's goal via the legacy settings fallback.
	g, err := r.GetGoal(ctx, 222)
	if err != nil {
		t.Fatalf("GetGoal user 222: %v", err)
	}
	if g == nil {
		t.Fatal("Expected non-nil empty WeightGoal for user with no history")
	}
	if g.Goal != nil {
		t.Errorf("Expected nil Goal for user 222 (no history), got %v — settings fallback leaked user 111's goal", *g.Goal)
	}
	if g.GoalDate != nil {
		t.Errorf("Expected nil GoalDate for user 222, got %v", g.GoalDate)
	}
}

func TestListGoals_OrderAndLimit(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Unix()
	// Three rows for user 1 at distinct times, plus one for user 2 to verify scoping.
	insertGoalHistory(t, r, 1, base, 90.0, "2026-04-01", float64Ptr(95.0))
	insertGoalHistory(t, r, 1, base+3600, 85.0, "2026-05-01", float64Ptr(92.0))
	insertGoalHistory(t, r, 1, base+7200, 80.0, "2026-06-01", nil)
	insertGoalHistory(t, r, 2, base+1, 60.0, "2026-04-15", float64Ptr(65.0))

	all, err := r.ListGoals(ctx, 1, 0)
	if err != nil {
		t.Fatalf("ListGoals all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("Expected 3 rows for user 1, got %d", len(all))
	}
	// Order: descending by set_at_unix.
	if all[0].SetAt.Unix() <= all[1].SetAt.Unix() || all[1].SetAt.Unix() <= all[2].SetAt.Unix() {
		t.Errorf("Rows not in DESC order: %v, %v, %v", all[0].SetAt, all[1].SetAt, all[2].SetAt)
	}
	if all[0].TargetWeight != 80.0 {
		t.Errorf("Expected newest row target_weight 80.0, got %.1f", all[0].TargetWeight)
	}
	if all[2].StartWeight == nil || *all[2].StartWeight != 95.0 {
		t.Errorf("Expected oldest row start_weight 95.0, got %+v", all[2].StartWeight)
	}
	// Newest row has nullable start_weight populated as nil.
	if all[0].StartWeight != nil {
		t.Errorf("Expected newest row start_weight nil, got %v", *all[0].StartWeight)
	}

	limited, err := r.ListGoals(ctx, 1, 2)
	if err != nil {
		t.Fatalf("ListGoals limit=2: %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("Expected 2 rows with limit=2, got %d", len(limited))
	}
	if limited[0].SetAt.Unix() != all[0].SetAt.Unix() {
		t.Errorf("Expected limit=2 to start at newest row")
	}

	// Per-user isolation: user 2 sees only their own row.
	other, err := r.ListGoals(ctx, 2, 0)
	if err != nil {
		t.Fatalf("ListGoals user 2: %v", err)
	}
	if len(other) != 1 {
		t.Fatalf("Expected 1 row for user 2, got %d", len(other))
	}
	if other[0].TargetWeight != 60.0 {
		t.Errorf("Expected user 2 row target_weight 60.0, got %.1f", other[0].TargetWeight)
	}
}

func TestSetGoal_InsertsHistoryRow(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	// A prior weight log so SetGoal can snapshot it into start_weight.
	if _, err := r.CreateLog(ctx, &WeightLog{
		UserID:     123,
		MeasuredAt: time.Date(2026, 5, 1, 8, 0, 0, 0, time.UTC),
		Weight:     88.4,
	}); err != nil {
		t.Fatalf("CreateLog failed: %v", err)
	}

	before := time.Now().UTC().Unix()
	targetDate := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	if err := r.SetGoal(ctx, 123, 80.0, targetDate); err != nil {
		t.Fatalf("SetGoal failed: %v", err)
	}
	after := time.Now().UTC().Unix()

	rows, err := r.ListGoals(ctx, 123, 0)
	if err != nil {
		t.Fatalf("ListGoals failed: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("Expected 1 history row after SetGoal, got %d", len(rows))
	}
	got := rows[0]
	if got.UserID != 123 {
		t.Errorf("Expected user_id 123, got %d", got.UserID)
	}
	if got.TargetWeight != 80.0 {
		t.Errorf("Expected target_weight 80.0, got %.1f", got.TargetWeight)
	}
	if got.TargetDate != "2026-09-01" {
		t.Errorf("Expected target_date 2026-09-01, got %q", got.TargetDate)
	}
	if got.StartWeight == nil || *got.StartWeight != 88.4 {
		t.Errorf("Expected start_weight 88.4 from latest log, got %+v", got.StartWeight)
	}
	if got.SetAt.Unix() < before || got.SetAt.Unix() > after {
		t.Errorf("Expected set_at_unix in [%d,%d], got %d", before, after, got.SetAt.Unix())
	}
}

func TestSetGoal_NullStartWeightWhenNoLog(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	targetDate := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	if err := r.SetGoal(ctx, 456, 70.0, targetDate); err != nil {
		t.Fatalf("SetGoal failed: %v", err)
	}

	rows, err := r.ListGoals(ctx, 456, 0)
	if err != nil {
		t.Fatalf("ListGoals failed: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("Expected 1 history row, got %d", len(rows))
	}
	if rows[0].StartWeight != nil {
		t.Errorf("Expected start_weight nil when no log exists, got %v", *rows[0].StartWeight)
	}
	// The goal itself still persists.
	goal, err := r.GetGoal(ctx, 456)
	if err != nil {
		t.Fatalf("GetGoal failed: %v", err)
	}
	if goal.Goal == nil || *goal.Goal != 70.0 {
		t.Errorf("Expected goal 70.0, got %+v", goal.Goal)
	}
}

func TestSetGoal_DualWritesToSettings(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	targetDate := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	if err := r.SetGoal(ctx, 789, 72.5, targetDate); err != nil {
		t.Fatalf("SetGoal failed: %v", err)
	}

	var settingsWeight sql.NullFloat64
	var settingsDate sql.NullString
	if err := r.db.QueryRow(
		"SELECT weight_goal, weight_goal_date FROM settings WHERE id = 1",
	).Scan(&settingsWeight, &settingsDate); err != nil {
		t.Fatalf("read settings: %v", err)
	}
	if !settingsWeight.Valid || settingsWeight.Float64 != 72.5 {
		t.Errorf("Expected settings.weight_goal 72.5, got %+v", settingsWeight)
	}
	if !settingsDate.Valid || settingsDate.String != "2026-08-15" {
		t.Errorf("Expected settings.weight_goal_date 2026-08-15, got %+v", settingsDate)
	}
}

func TestSetGoal_ResnapshotsOnEverySave(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	if _, err := r.CreateLog(ctx, &WeightLog{
		UserID:     321,
		MeasuredAt: time.Date(2026, 4, 1, 8, 0, 0, 0, time.UTC),
		Weight:     90.0,
	}); err != nil {
		t.Fatalf("CreateLog 1 failed: %v", err)
	}
	if err := r.SetGoal(ctx, 321, 80.0, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("SetGoal 1 failed: %v", err)
	}

	// Sleep a touch to guarantee a distinct set_at_unix on the second call —
	// unix() seconds are coarse but we just need them to differ in this test.
	time.Sleep(1100 * time.Millisecond)

	if _, err := r.CreateLog(ctx, &WeightLog{
		UserID:     321,
		MeasuredAt: time.Date(2026, 4, 15, 8, 0, 0, 0, time.UTC),
		Weight:     87.6,
	}); err != nil {
		t.Fatalf("CreateLog 2 failed: %v", err)
	}
	if err := r.SetGoal(ctx, 321, 80.0, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("SetGoal 2 failed: %v", err)
	}

	rows, err := r.ListGoals(ctx, 321, 0)
	if err != nil {
		t.Fatalf("ListGoals failed: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("Expected 2 history rows, got %d", len(rows))
	}
	// Newest first.
	if rows[0].SetAt.Unix() <= rows[1].SetAt.Unix() {
		t.Errorf("Expected distinct set_at_unix (newest first), got %d, %d",
			rows[0].SetAt.Unix(), rows[1].SetAt.Unix())
	}
	if rows[0].StartWeight == nil || *rows[0].StartWeight != 87.6 {
		t.Errorf("Expected second snapshot start_weight 87.6, got %+v", rows[0].StartWeight)
	}
	if rows[1].StartWeight == nil || *rows[1].StartWeight != 90.0 {
		t.Errorf("Expected first snapshot start_weight 90.0, got %+v", rows[1].StartWeight)
	}
}

func TestSetGoal_TransactionRollback(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	// Drop the settings table to force the UPDATE inside the tx to fail. The
	// history INSERT runs first; the failed UPDATE must roll the whole tx back
	// so no orphan weight_goals row remains.
	if _, err := r.db.Exec("DROP TABLE settings"); err != nil {
		t.Fatalf("drop settings: %v", err)
	}

	err := r.SetGoal(ctx, 999, 75.0, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC))
	if err == nil {
		t.Fatal("Expected SetGoal to fail when settings UPDATE errors out")
	}

	rows, err := r.ListGoals(ctx, 999, 0)
	if err != nil {
		t.Fatalf("ListGoals failed: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("Expected 0 history rows after rollback, got %d", len(rows))
	}
}

func TestCalculateWeightTrendNilPrevious(t *testing.T) {
	result := CalculateWeightTrend(85.0, nil)
	if result != 85.0 {
		t.Errorf("Expected 85.0 for nil previous trend, got %.1f", result)
	}
}

func TestCalculateWeightTrendWithPrevious(t *testing.T) {
	previous := 80.0
	current := 85.0

	result := CalculateWeightTrend(current, &previous)

	// EMA: 0.1 * current + 0.9 * previous = 0.1*85 + 0.9*80 = 8.5 + 72 = 80.5
	expected := 0.1*current + 0.9*previous
	if math.Abs(result-expected) > 0.001 {
		t.Errorf("Expected %.3f, got %.3f", expected, result)
	}
}

func TestCalculateWeightTrendConvergence(t *testing.T) {
	// Simulate multiple readings at 85.0 with initial trend of 80.0
	trend := 80.0
	for i := 0; i < 50; i++ {
		trend = CalculateWeightTrend(85.0, &trend)
	}

	// After many iterations, trend should converge toward 85.0
	if math.Abs(trend-85.0) > 0.1 {
		t.Errorf("Trend should converge to 85.0, got %.3f", trend)
	}
}
