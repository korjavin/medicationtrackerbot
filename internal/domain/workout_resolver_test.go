package domain

import (
	"context"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeWorkoutResolverStore lets tests set up a deterministic catalog and
// recent-log history without touching SQLite.
type fakeWorkoutResolverStore struct {
	catalog []string
	// recentLogs is keyed by lowercased exercise name; each slice is newest-first.
	recentLogs map[string][]store.WorkoutExerciseLog
}

func (f *fakeWorkoutResolverStore) GetDistinctExerciseNamesForUser(ctx context.Context, userID int64) ([]string, error) {
	out := make([]string, len(f.catalog))
	copy(out, f.catalog)
	return out, nil
}

func (f *fakeWorkoutResolverStore) ListRecentExerciseLogsByName(ctx context.Context, userID int64, exerciseName string, limit int) ([]store.WorkoutExerciseLog, error) {
	logs := f.recentLogs[strings.ToLower(exerciseName)]
	if len(logs) == 0 {
		return nil, nil
	}
	if limit > 0 && len(logs) > limit {
		logs = logs[:limit]
	}
	// Defensive copy.
	out := make([]store.WorkoutExerciseLog, len(logs))
	copy(out, logs)
	return out, nil
}

func intPtr(v int) *int           { return &v }
func floatPtr(v float64) *float64 { return &v }

func TestResolveExercise_ExactMatch(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Biceps Curls", "Bench Press"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name:     "biceps curls",
		Sets:     intPtr(3),
		Reps:     intPtr(10),
		WeightKg: floatPtr(12.5),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", plan.Status)
	}
	if plan.ResolvedName != "Biceps Curls" {
		t.Errorf("resolved name = %q, want %q", plan.ResolvedName, "Biceps Curls")
	}
	if plan.Applied.Sets == nil || *plan.Applied.Sets != 3 {
		t.Errorf("sets not propagated: %+v", plan.Applied.Sets)
	}
	if plan.Sources.Sets != SourceAgent {
		t.Errorf("source = %s, want agent", plan.Sources.Sets)
	}
}

func TestResolveExercise_SubstringMatch(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Bench Press", "Squat"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "bench", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(60),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", plan.Status)
	}
	if plan.ResolvedName != "Bench Press" {
		t.Errorf("resolved = %q, want Bench Press", plan.ResolvedName)
	}
}

func TestResolveExercise_LevenshteinMatch(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Deadlift", "Squat"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "deadlif", Sets: intPtr(1), Reps: intPtr(5), WeightKg: floatPtr(100),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", plan.Status)
	}
	if plan.ResolvedName != "Deadlift" {
		t.Errorf("resolved = %q, want Deadlift", plan.ResolvedName)
	}
}

func TestResolveExercise_Ambiguous(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Bench Press", "Inclined Press", "Squat"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "press", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(60),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusAmbiguous {
		t.Fatalf("status = %s, want ambiguous", plan.Status)
	}
	if len(plan.Candidates) != 2 {
		t.Errorf("candidates = %v, want 2", plan.Candidates)
	}
	if plan.Hint == "" {
		t.Error("expected non-empty hint")
	}
}

func TestResolveExercise_NoMatchWithDefaults_CreatesNew(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Squat"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "Yoga Flow", Sets: intPtr(1), Reps: intPtr(1), WeightKg: floatPtr(0.1),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusCreateNew {
		t.Fatalf("status = %s, want create_new", plan.Status)
	}
	if plan.ResolvedName != "Yoga Flow" {
		t.Errorf("resolved = %q, want Yoga Flow (literal trimmed)", plan.ResolvedName)
	}
}

func TestResolveExercise_NoMatchNoDefaults(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Squat"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{Name: "Yoga Flow"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusMissingDefaults {
		t.Fatalf("status = %s, want missing_defaults", plan.Status)
	}
	wantMissing := []string{"sets", "reps", "weight_kg"}
	if len(plan.Missing) != len(wantMissing) {
		t.Errorf("missing = %v, want %v", plan.Missing, wantMissing)
	}
}

func TestResolveExercise_InferenceFromHistory(t *testing.T) {
	sets, reps := 4, 12
	weight := 22.5
	s := &fakeWorkoutResolverStore{
		catalog: []string{"Biceps Curls"},
		recentLogs: map[string][]store.WorkoutExerciseLog{
			"biceps curls": {{
				ExerciseName:  "Biceps Curls",
				SetsCompleted: &sets,
				RepsCompleted: &reps,
				WeightKg:      &weight,
			}},
		},
	}
	r := NewWorkoutResolver(s)

	// Agent omits all numeric fields → resolver should fill from history.
	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{Name: "biceps curls"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", plan.Status)
	}
	if plan.Applied.Sets == nil || *plan.Applied.Sets != 4 {
		t.Errorf("sets = %v, want 4", plan.Applied.Sets)
	}
	if plan.Applied.Reps == nil || *plan.Applied.Reps != 12 {
		t.Errorf("reps = %v, want 12", plan.Applied.Reps)
	}
	if plan.Applied.WeightKg == nil || *plan.Applied.WeightKg != 22.5 {
		t.Errorf("weight = %v, want 22.5", plan.Applied.WeightKg)
	}
	if plan.Sources.Sets != SourceInferred || plan.Sources.Reps != SourceInferred || plan.Sources.WeightKg != SourceInferred {
		t.Errorf("expected all inferred, got %+v", plan.Sources)
	}
}

func TestResolveExercise_PartialAgentFieldsInference(t *testing.T) {
	sets, reps := 4, 12
	weight := 22.5
	s := &fakeWorkoutResolverStore{
		catalog: []string{"Biceps Curls"},
		recentLogs: map[string][]store.WorkoutExerciseLog{
			"biceps curls": {{SetsCompleted: &sets, RepsCompleted: &reps, WeightKg: &weight}},
		},
	}
	r := NewWorkoutResolver(s)

	// Agent provides sets only; resolver should infer reps and weight.
	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "biceps curls",
		Sets: intPtr(5),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *plan.Applied.Sets != 5 || plan.Sources.Sets != SourceAgent {
		t.Errorf("sets not from agent: %v %s", plan.Applied.Sets, plan.Sources.Sets)
	}
	if *plan.Applied.Reps != 12 || plan.Sources.Reps != SourceInferred {
		t.Errorf("reps not inferred: %v %s", plan.Applied.Reps, plan.Sources.Reps)
	}
	if *plan.Applied.WeightKg != 22.5 || plan.Sources.WeightKg != SourceInferred {
		t.Errorf("weight not inferred: %v %s", plan.Applied.WeightKg, plan.Sources.WeightKg)
	}
}

func TestResolveExercise_PerSetAggregation(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Bench Press"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "Bench Press",
		PerSet: []PerSetEntry{
			{Reps: intPtr(10), WeightKg: floatPtr(40)},
			{Reps: intPtr(8), WeightKg: floatPtr(50)},
			{Reps: intPtr(6), WeightKg: floatPtr(55)},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", plan.Status)
	}
	if *plan.Applied.Sets != 3 {
		t.Errorf("sets = %v, want 3", plan.Applied.Sets)
	}
	if *plan.Applied.Reps != 10 {
		t.Errorf("reps = %v, want 10 (max)", plan.Applied.Reps)
	}
	if *plan.Applied.WeightKg != 55 {
		t.Errorf("weight = %v, want 55 (max)", plan.Applied.WeightKg)
	}
	if plan.Sources.Sets != SourcePerSet {
		t.Errorf("source = %s, want per_set", plan.Sources.Sets)
	}
}

func TestResolveExercise_PerSetWinsOverFlat(t *testing.T) {
	s := &fakeWorkoutResolverStore{catalog: []string{"Bench Press"}}
	r := NewWorkoutResolver(s)

	// Flat fields are ignored when per_set is present (per the protocol).
	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name:     "Bench Press",
		Sets:     intPtr(99),
		Reps:     intPtr(99),
		WeightKg: floatPtr(99),
		PerSet: []PerSetEntry{
			{Reps: intPtr(10), WeightKg: floatPtr(40)},
			{Reps: intPtr(8), WeightKg: floatPtr(50)},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *plan.Applied.Sets != 2 || *plan.Applied.Reps != 10 || *plan.Applied.WeightKg != 50 {
		t.Errorf("per_set should win, got %+v", plan.Applied)
	}
}

func TestResolveExercise_PerSetBodyweight(t *testing.T) {
	// Bodyweight exercises (pull-ups, push-ups, dips) are sent with weight_kg=0.
	// per_set must be authoritative — zero weight is a valid value, not "missing".
	s := &fakeWorkoutResolverStore{catalog: []string{"Pull Up"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name: "Pull Up",
		PerSet: []PerSetEntry{
			{Reps: intPtr(10), WeightKg: floatPtr(0)},
			{Reps: intPtr(8), WeightKg: floatPtr(0)},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved (bodyweight per_set)", plan.Status)
	}
	if plan.Applied.WeightKg == nil || *plan.Applied.WeightKg != 0 {
		t.Errorf("weight should be 0 (explicit bodyweight), got %+v", plan.Applied.WeightKg)
	}
	if plan.Sources.WeightKg != SourcePerSet {
		t.Errorf("weight source = %s, want per_set", plan.Sources.WeightKg)
	}
}

func TestResolveExercise_DurationOnlyCardio(t *testing.T) {
	// Cardio-style payload: only duration, no sets/reps/weight, no history.
	s := &fakeWorkoutResolverStore{catalog: []string{"Running"}}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{
		Name:            "Running",
		DurationMinutes: intPtr(30),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved (cardio with duration)", plan.Status)
	}
	if *plan.Applied.DurationMinutes != 30 {
		t.Errorf("duration = %v, want 30", plan.Applied.DurationMinutes)
	}
}

func TestResolveExercise_EmptyName(t *testing.T) {
	s := &fakeWorkoutResolverStore{}
	r := NewWorkoutResolver(s)

	plan, err := r.ResolveExercise(context.Background(), 1, ResolverInput{Name: "  "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Status != StatusMissingDefaults {
		t.Errorf("status = %s, want missing_defaults", plan.Status)
	}
	if len(plan.Missing) == 0 || plan.Missing[0] != "name" {
		t.Errorf("expected missing=name, got %v", plan.Missing)
	}
}

func TestLevenshtein(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"abc", "abc", 0},
		{"abc", "abd", 1},
		{"abc", "abcd", 1},
		{"kitten", "sitting", 3},
		{"deadlift", "deadlif", 1},
	}
	for _, c := range cases {
		if got := levenshtein(c.a, c.b); got != c.want {
			t.Errorf("levenshtein(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestResolveName_AmbiguousFromLevenshtein(t *testing.T) {
	// Neither catalog name substring-matches "frt", but both are within
	// Levenshtein distance 2 of it → ambiguous.
	catalog := []string{"fro", "art"}
	resolved, candidates, kind := resolveName("frt", catalog)
	if kind != matchAmbiguous {
		t.Fatalf("kind = %d, want ambiguous", kind)
	}
	if resolved != "" {
		t.Errorf("resolved = %q, want empty for ambiguous", resolved)
	}
	if len(candidates) != 2 {
		t.Errorf("candidates = %v, want 2", candidates)
	}
}
