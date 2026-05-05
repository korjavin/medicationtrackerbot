package seeddemo

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// exerciseSpec is one row inside a variant's exercise list. weightKg is
// optional (zero means bodyweight).
type exerciseSpec struct {
	name     string
	sets     int
	repsMin  int
	repsMax  int
	weightKg float64
}

// variantSpec describes one variant of a workout group.
type variantSpec struct {
	name      string
	rotation  int // -1 means non-rotating (single variant)
	exercises []exerciseSpec
}

// groupSpec describes one workout group: its schedule, whether it rotates,
// and its variants (with exercises).
type groupSpec struct {
	name          string
	description   string
	isRotating    bool
	daysOfWeek    []int // time.Weekday() values (Sunday=0..Saturday=6)
	scheduledTime string
	notifyAdvance int
	variants      []variantSpec
}

// demoStrengthGroup is the rotating Push/Pull/Legs split, Mon/Wed/Fri 18:00.
var demoStrengthGroup = groupSpec{
	name:          "Strength",
	description:   "Push/Pull/Legs split, three days a week.",
	isRotating:    true,
	daysOfWeek:    []int{1, 3, 5}, // Mon, Wed, Fri
	scheduledTime: "18:00",
	notifyAdvance: 15,
	variants: []variantSpec{
		{
			name:     "Push",
			rotation: 0,
			exercises: []exerciseSpec{
				{name: "Bench Press", sets: 4, repsMin: 6, repsMax: 8, weightKg: 60},
				{name: "Overhead Press", sets: 3, repsMin: 8, repsMax: 10, weightKg: 35},
				{name: "Incline Dumbbell Press", sets: 3, repsMin: 8, repsMax: 12, weightKg: 22.5},
				{name: "Triceps Pushdown", sets: 3, repsMin: 10, repsMax: 12, weightKg: 25},
			},
		},
		{
			name:     "Pull",
			rotation: 1,
			exercises: []exerciseSpec{
				{name: "Deadlift", sets: 4, repsMin: 5, repsMax: 6, weightKg: 100},
				{name: "Pull-ups", sets: 4, repsMin: 6, repsMax: 10, weightKg: 0},
				{name: "Barbell Row", sets: 3, repsMin: 8, repsMax: 10, weightKg: 60},
				{name: "Biceps Curl", sets: 3, repsMin: 10, repsMax: 12, weightKg: 15},
			},
		},
		{
			name:     "Legs",
			rotation: 2,
			exercises: []exerciseSpec{
				{name: "Back Squat", sets: 4, repsMin: 6, repsMax: 8, weightKg: 80},
				{name: "Romanian Deadlift", sets: 3, repsMin: 8, repsMax: 10, weightKg: 70},
				{name: "Walking Lunges", sets: 3, repsMin: 10, repsMax: 12, weightKg: 20},
				{name: "Standing Calf Raise", sets: 4, repsMin: 12, repsMax: 15, weightKg: 40},
			},
		},
	},
}

// demoCardioGroup is a static (non-rotating) group, Tue/Sat 07:00.
var demoCardioGroup = groupSpec{
	name:          "Cardio",
	description:   "Steady-state cardio mornings.",
	isRotating:    false,
	daysOfWeek:    []int{2, 6}, // Tue, Sat
	scheduledTime: "07:00",
	notifyAdvance: 15,
	variants: []variantSpec{
		{
			name:     "Default",
			rotation: -1,
			exercises: []exerciseSpec{
				{name: "Treadmill", sets: 1, repsMin: 30, repsMax: 30, weightKg: 0},
				{name: "Rowing", sets: 1, repsMin: 15, repsMax: 15, weightKg: 0},
			},
		},
	},
}

// adHocSessionSpec describes one of the unscheduled "library" sessions
// that pepper the demo timeline. dayOffset is days-from-anchor (positive
// = past).
type adHocSessionSpec struct {
	dayOffset int
	hour      int
	minute    int
	exercises []exerciseSpec
}

// demoAdHocSessions are scattered through the window so the workout history
// shows mixed scheduled + ad-hoc activity.
var demoAdHocSessions = []adHocSessionSpec{
	{dayOffset: 80, hour: 7, minute: 30, exercises: []exerciseSpec{
		{name: "Plank", sets: 3, repsMin: 60, repsMax: 60, weightKg: 0},
		{name: "Push-ups", sets: 3, repsMin: 15, repsMax: 20, weightKg: 0},
	}},
	{dayOffset: 62, hour: 18, minute: 15, exercises: []exerciseSpec{
		{name: "Kettlebell Swing", sets: 5, repsMin: 15, repsMax: 15, weightKg: 16},
		{name: "Goblet Squat", sets: 3, repsMin: 10, repsMax: 10, weightKg: 16},
	}},
	{dayOffset: 45, hour: 12, minute: 0, exercises: []exerciseSpec{
		{name: "Farmer Walk", sets: 3, repsMin: 30, repsMax: 30, weightKg: 24},
		{name: "Plank", sets: 3, repsMin: 45, repsMax: 60, weightKg: 0},
	}},
	{dayOffset: 28, hour: 19, minute: 30, exercises: []exerciseSpec{
		{name: "Deadlift", sets: 5, repsMin: 5, repsMax: 5, weightKg: 80},
		{name: "Pull-ups", sets: 4, repsMin: 5, repsMax: 8, weightKg: 0},
		{name: "Plank", sets: 3, repsMin: 60, repsMax: 60, weightKg: 0},
	}},
	{dayOffset: 9, hour: 7, minute: 45, exercises: []exerciseSpec{
		{name: "Burpees", sets: 4, repsMin: 12, repsMax: 12, weightKg: 0},
		{name: "Mountain Climbers", sets: 4, repsMin: 30, repsMax: 30, weightKg: 0},
	}},
}

// generateWorkouts seeds the workout schedule (groups + variants + exercises),
// walks the synthetic 90-day window producing scheduled sessions with a
// realistic completed/skipped/in-progress/pending mix, and adds a handful
// of ad-hoc library-sourced sessions.
func generateWorkouts(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	pendingCutoff := clk.daysFromAnchor(2)

	strengthGroup, strengthVariants, err := seedWorkoutGroup(s, opts.UserID, demoStrengthGroup)
	if err != nil {
		return fmt.Errorf("seed strength group: %w", err)
	}
	cardioGroup, cardioVariants, err := seedWorkoutGroup(s, opts.UserID, demoCardioGroup)
	if err != nil {
		return fmt.Errorf("seed cardio group: %w", err)
	}

	if err := generateScheduledSessions(ctx, s, opts, clk, rng, summary, strengthGroup, strengthVariants, demoStrengthGroup, pendingCutoff); err != nil {
		return fmt.Errorf("scheduled strength sessions: %w", err)
	}
	if err := generateScheduledSessions(ctx, s, opts, clk, rng, summary, cardioGroup, cardioVariants, demoCardioGroup, pendingCutoff); err != nil {
		return fmt.Errorf("scheduled cardio sessions: %w", err)
	}
	if err := generateAdHocSessions(ctx, s, opts, clk, summary); err != nil {
		return fmt.Errorf("ad-hoc sessions: %w", err)
	}
	return nil
}

// seedWorkoutGroup creates the group, its variants (with exercises), and —
// when rotating — initialises the rotation pointer on the first variant.
// Returns the group along with a rotation-ordered slice of variants whose
// exercise IDs have been resolved.
func seedWorkoutGroup(s *store.Store, userID int64, spec groupSpec) (*store.WorkoutGroup, []variantWithExercises, error) {
	daysJSON := jsonIntArray(spec.daysOfWeek)
	group, err := s.CreateWorkoutGroup(spec.name, spec.description, spec.isRotating, userID, daysJSON, spec.scheduledTime, spec.notifyAdvance)
	if err != nil {
		return nil, nil, fmt.Errorf("create group %s: %w", spec.name, err)
	}

	variants := make([]variantWithExercises, 0, len(spec.variants))
	for _, v := range spec.variants {
		var rotPtr *int
		if v.rotation >= 0 {
			r := v.rotation
			rotPtr = &r
		}
		variant, err := s.CreateWorkoutVariant(group.ID, v.name, rotPtr, "")
		if err != nil {
			return nil, nil, fmt.Errorf("create variant %s/%s: %w", spec.name, v.name, err)
		}
		exercises := make([]storeExerciseID, 0, len(v.exercises))
		for i, ex := range v.exercises {
			repsMax := ex.repsMax
			var weightPtr *float64
			if ex.weightKg > 0 {
				w := ex.weightKg
				weightPtr = &w
			}
			row, err := s.AddExerciseToVariant(variant.ID, ex.name, ex.sets, ex.repsMin, &repsMax, weightPtr, i)
			if err != nil {
				return nil, nil, fmt.Errorf("add exercise %s/%s/%s: %w", spec.name, v.name, ex.name, err)
			}
			exercises = append(exercises, storeExerciseID{id: row.ID, spec: ex})
		}
		variants = append(variants, variantWithExercises{variant: variant, exercises: exercises})
	}

	if spec.isRotating && len(variants) > 0 {
		if err := s.InitializeRotation(group.ID, variants[0].variant.ID); err != nil {
			return nil, nil, fmt.Errorf("init rotation %s: %w", spec.name, err)
		}
	}
	return group, variants, nil
}

type variantWithExercises struct {
	variant   *store.WorkoutVariant
	exercises []storeExerciseID
}

type storeExerciseID struct {
	id   int64
	spec exerciseSpec
}

// generateScheduledSessions iterates every day in the window, and on days
// matching the group's days_of_week creates a session row with status,
// timestamps and (for completed sessions) backdated exercise logs.
func generateScheduledSessions(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary, group *store.WorkoutGroup, variants []variantWithExercises, spec groupSpec, pendingCutoff time.Time) error {
	if len(variants) == 0 {
		return nil
	}
	dowSet := make(map[int]bool, len(spec.daysOfWeek))
	for _, d := range spec.daysOfWeek {
		dowSet[d] = true
	}

	rotationIdx := 0
	totalDays := opts.Days
	for off := 0; off < totalDays; off++ {
		day := clk.dayOffset(off)
		if !dowSet[int(day.Weekday())] {
			continue
		}

		var variant variantWithExercises
		if spec.isRotating {
			variant = variants[rotationIdx%len(variants)]
		} else {
			variant = variants[0]
		}

		scheduledAt, ok := timeOfDay(day, spec.scheduledTime)
		if !ok {
			return fmt.Errorf("bad scheduled_time %q for %s", spec.scheduledTime, spec.name)
		}

		// Sessions in the last 2 days remain pending.
		if !scheduledAt.Before(pendingCutoff) {
			if _, err := insertWorkoutSession(ctx, s, group.ID, variant.variant.ID, opts.UserID, day, spec.scheduledTime, "pending", nil, nil); err != nil {
				return fmt.Errorf("insert pending session: %w", err)
			}
			summary.WorkoutSessions++
			continue
		}

		outcome := pickSessionOutcome(rng)
		switch outcome {
		case "skipped":
			if _, err := insertWorkoutSession(ctx, s, group.ID, variant.variant.ID, opts.UserID, day, spec.scheduledTime, "skipped", nil, nil); err != nil {
				return fmt.Errorf("insert skipped session: %w", err)
			}
			summary.WorkoutSessions++
			if spec.isRotating {
				rotationIdx++
				if err := s.AdvanceRotation(group.ID); err != nil {
					return fmt.Errorf("advance rotation (skipped): %w", err)
				}
			}
		case "completed", "in_progress_completed":
			completedAt := scheduledAt.Add(time.Duration(45+rng.IntN(20)) * time.Minute)
			var startedAtPtr *time.Time
			if outcome == "in_progress_completed" {
				started := scheduledAt.Add(time.Duration(rng.IntN(10)) * time.Minute)
				startedAtPtr = &started
			}
			completedCopy := completedAt
			sessionID, err := insertWorkoutSession(ctx, s, group.ID, variant.variant.ID, opts.UserID, day, spec.scheduledTime, "completed", startedAtPtr, &completedCopy)
			if err != nil {
				return fmt.Errorf("insert completed session: %w", err)
			}
			summary.WorkoutSessions++

			// off=0 is the oldest day in the window, off=totalDays-1 is the most
			// recent. progression climbs from 0 (oldest) to 1 (newest) so weights
			// trend up across the timeline.
			progression := 0.0
			if totalDays > 1 {
				progression = float64(off) / float64(totalDays-1)
			}
			for _, ex := range variant.exercises {
				if err := insertExerciseLog(ctx, s, sessionID, ex, rng, progression, scheduledAt); err != nil {
					return fmt.Errorf("insert exercise log: %w", err)
				}
				summary.ExerciseLogs++
			}
			if spec.isRotating {
				rotationIdx++
				if err := s.AdvanceRotation(group.ID); err != nil {
					return fmt.Errorf("advance rotation (completed): %w", err)
				}
			}
		}
	}
	return nil
}

// pickSessionOutcome chooses the lifecycle for a past-window session: 70%
// completed, 15% skipped, 15% in_progress→completed.
func pickSessionOutcome(rng *rand.Rand) string {
	roll := rng.IntN(100)
	switch {
	case roll < 70:
		return "completed"
	case roll < 85:
		return "skipped"
	default:
		return "in_progress_completed"
	}
}

// insertWorkoutSession writes a session row directly so its timestamps can
// be backdated. The store's CreateWorkoutSession always sets status=pending
// and uses CURRENT_TIMESTAMP, neither of which fits our backfill needs.
func insertWorkoutSession(ctx context.Context, s *store.Store, groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime, status string, startedAt, completedAt *time.Time) (int64, error) {
	res, err := s.DB().ExecContext(ctx, `
		INSERT INTO workout_sessions (group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		groupID, variantID, userID, scheduledDate, scheduledTime, status, nullableTime(startedAt), nullableTime(completedAt))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// insertExerciseLog writes a backdated exercise log row. progression is
// 0 (oldest) to 1 (newest); weights climb by up to ~12% across the window
// so the strength chart trends upward.
func insertExerciseLog(ctx context.Context, s *store.Store, sessionID int64, ex storeExerciseID, rng *rand.Rand, progression float64, sessionStart time.Time) error {
	sets := ex.spec.sets
	reps := ex.spec.repsMin
	if ex.spec.repsMax > ex.spec.repsMin {
		reps = ex.spec.repsMin + rng.IntN(ex.spec.repsMax-ex.spec.repsMin+1)
	}

	var weightPtr *float64
	if ex.spec.weightKg > 0 {
		w := ex.spec.weightKg * (1 + 0.12*progression)
		w += gaussian(rng, 0, 0.5)
		w = float64(int(w*2+0.5)) / 2 // round to 0.5 kg
		if w < ex.spec.weightKg*0.85 {
			w = ex.spec.weightKg * 0.85
		}
		weightPtr = &w
	}

	loggedAt := sessionStart.Add(time.Duration(rng.IntN(40)+5) * time.Minute)

	_, err := s.DB().ExecContext(ctx, `
		INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, source, logged_at)
		VALUES (?, ?, ?, ?, ?, ?, 'completed', 'schedule', ?)`,
		sessionID, ex.id, ex.spec.name, sets, reps, nullableFloat(weightPtr), loggedAt)
	return err
}

// generateAdHocSessions inserts unscheduled completed sessions whose
// exercise logs use source="library" — exercising the path where the user
// records a workout outside any planned group.
func generateAdHocSessions(ctx context.Context, s *store.Store, opts Options, clk *clock, summary *Summary) error {
	for _, ah := range demoAdHocSessions {
		if ah.dayOffset >= opts.Days {
			continue
		}
		off := opts.Days - ah.dayOffset // convert "days from anchor" to clock offset
		if off < 0 || off >= opts.Days {
			continue
		}
		day := clk.dayOffset(off)
		startedAt := time.Date(day.Year(), day.Month(), day.Day(), ah.hour, ah.minute, 0, 0, time.UTC)
		completedAt := startedAt.Add(40 * time.Minute)
		scheduledTime := fmt.Sprintf("%02d:%02d", ah.hour, ah.minute)

		res, err := s.DB().ExecContext(ctx, `
			INSERT INTO workout_sessions (group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at)
			VALUES (-1, -1, ?, ?, ?, 'completed', ?, ?)`,
			opts.UserID, day, scheduledTime, startedAt, completedAt)
		if err != nil {
			return fmt.Errorf("insert ad-hoc session: %w", err)
		}
		sessionID, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("ad-hoc last insert id: %w", err)
		}
		summary.WorkoutSessions++

		for i, ex := range ah.exercises {
			loggedAt := startedAt.Add(time.Duration(5+i*7) * time.Minute)
			var weightPtr *float64
			if ex.weightKg > 0 {
				w := ex.weightKg
				weightPtr = &w
			}
			// Ad-hoc logs have no scheduled exercise row, so exercise_id=0.
			if _, err := s.DB().ExecContext(ctx, `
				INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, source, logged_at)
				VALUES (?, 0, ?, ?, ?, ?, 'completed', 'library', ?)`,
				sessionID, ex.name, ex.sets, ex.repsMin, nullableFloat(weightPtr), loggedAt); err != nil {
				return fmt.Errorf("insert ad-hoc log: %w", err)
			}
			summary.ExerciseLogs++
		}
	}
	return nil
}

// jsonIntArray serialises a small int slice into a JSON array literal — the
// format days_of_week stores. Avoids dragging encoding/json in for two
// values.
func jsonIntArray(vals []int) string {
	out := "["
	for i, v := range vals {
		if i > 0 {
			out += ","
		}
		out += fmt.Sprintf("%d", v)
	}
	out += "]"
	return out
}

func nullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func nullableFloat(f *float64) any {
	if f == nil {
		return sql.NullFloat64{}
	}
	return *f
}
