package domain

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// WorkoutResolverStore is the narrow store interface required by the resolver.
type WorkoutResolverStore interface {
	GetDistinctExerciseNamesForUser(ctx context.Context, userID int64) ([]string, error)
	ListRecentExerciseLogsByName(ctx context.Context, userID int64, exerciseName string, limit int) ([]store.WorkoutExerciseLog, error)
}

// PerSetEntry is a single set inside a rich payload. Reps and WeightKg are
// pointer-typed so an omitted field (nil) is distinguishable from explicit
// zero — bodyweight exercises legitimately send weight_kg=0, but a payload
// that omits weight_kg should let inference fill it from history rather
// than corrupting stats with an unintended zero.
type PerSetEntry struct {
	Reps     *int     `json:"reps,omitempty"`
	WeightKg *float64 `json:"weight_kg,omitempty"`
}

// ResolverInput is one exercise as received from the agent.
// All numeric fields are pointer-typed so we can distinguish
// "omitted" (will be inferred) from "explicitly zero".
type ResolverInput struct {
	Name            string        `json:"name"`
	Sets            *int          `json:"sets,omitempty"`
	Reps            *int          `json:"reps,omitempty"`
	WeightKg        *float64      `json:"weight_kg,omitempty"`
	DurationMinutes *int          `json:"duration_minutes,omitempty"`
	Notes           string        `json:"notes,omitempty"`
	PerSet          []PerSetEntry `json:"per_set,omitempty"`
}

// ResolverPlanStatus describes the resolver's verdict for one input exercise.
type ResolverPlanStatus string

const (
	StatusResolved        ResolverPlanStatus = "resolved"
	StatusAmbiguous       ResolverPlanStatus = "ambiguous"
	StatusMissingDefaults ResolverPlanStatus = "missing_defaults"
	StatusCreateNew       ResolverPlanStatus = "create_new"
)

// FieldSource indicates where each applied numeric value came from.
type FieldSource string

const (
	SourceAgent    FieldSource = "agent"
	SourceInferred FieldSource = "inferred"
	SourcePerSet   FieldSource = "per_set"
)

// AppliedValues holds the final per-exercise numbers the server intends to write.
type AppliedValues struct {
	Sets            *int     `json:"sets,omitempty"`
	Reps            *int     `json:"reps,omitempty"`
	WeightKg        *float64 `json:"weight_kg,omitempty"`
	DurationMinutes *int     `json:"duration_minutes,omitempty"`
}

// FieldSources tracks the source for each applied numeric field.
type FieldSources struct {
	Sets     FieldSource `json:"sets,omitempty"`
	Reps     FieldSource `json:"reps,omitempty"`
	WeightKg FieldSource `json:"weight_kg,omitempty"`
}

// ResolverPlan is the per-exercise outcome of resolution + inference.
// The HTTP handler decides what to do with this plan (write, error, etc).
type ResolverPlan struct {
	InputName    string             `json:"input_name"`
	ResolvedName string             `json:"resolved_name,omitempty"`
	Status       ResolverPlanStatus `json:"status"`
	// Candidates is set when Status == StatusAmbiguous: the matching catalog names.
	Candidates []string `json:"candidates,omitempty"`
	// Missing is set when Status == StatusMissingDefaults: which fields are absent.
	Missing []string `json:"missing,omitempty"`
	// Hint is a short message intended for the agent to self-correct.
	Hint    string        `json:"hint,omitempty"`
	Notes   string        `json:"notes,omitempty"`
	Applied AppliedValues `json:"applied,omitempty"`
	Sources FieldSources  `json:"sources,omitempty"`
	// PerSet is preserved for the writer in case it wants to record per-set
	// notes; the aggregate values are already in Applied.
	PerSet []PerSetEntry `json:"per_set,omitempty"`
}

// WorkoutResolver resolves agent-supplied exercise payloads to the canonical
// names + numeric defaults that the server will persist. It is intentionally
// pure-ish: aside from the store reads it performs, the same input always
// produces the same plan.
type WorkoutResolver interface {
	ResolveExercise(ctx context.Context, userID int64, input ResolverInput) (ResolverPlan, error)
}

type workoutResolver struct {
	store WorkoutResolverStore
}

// NewWorkoutResolver wires a resolver around the given store.
func NewWorkoutResolver(s WorkoutResolverStore) WorkoutResolver {
	return &workoutResolver{store: s}
}

// ResolveExercise implements WorkoutResolver.
func (r *workoutResolver) ResolveExercise(ctx context.Context, userID int64, input ResolverInput) (ResolverPlan, error) {
	plan := ResolverPlan{
		InputName: input.Name,
		Notes:     input.Notes,
		PerSet:    input.PerSet,
	}

	trimmed := strings.TrimSpace(input.Name)
	if trimmed == "" {
		plan.Status = StatusMissingDefaults
		plan.Missing = []string{"name"}
		plan.Hint = "exercise name is required"
		return plan, nil
	}

	// Step 1: resolve the name against the user's catalog.
	catalog, err := r.store.GetDistinctExerciseNamesForUser(ctx, userID)
	if err != nil {
		return plan, fmt.Errorf("load exercise catalog: %w", err)
	}
	resolved, candidates, status := resolveName(trimmed, catalog)

	switch status {
	case matchExact, matchSingleFuzzy:
		plan.ResolvedName = resolved
		// Step 2: aggregate per-set if present, else use flat fields.
		applied, sources := mergePayloadValues(input)
		// Step 3: fill in defaults from history for any missing fields.
		if applied.Sets == nil || applied.Reps == nil || applied.WeightKg == nil {
			recent, err := r.store.ListRecentExerciseLogsByName(ctx, userID, resolved, 1)
			if err != nil {
				return plan, fmt.Errorf("load recent log for %q: %w", resolved, err)
			}
			if len(recent) > 0 {
				log := recent[0]
				if applied.Sets == nil && log.SetsCompleted != nil {
					v := *log.SetsCompleted
					applied.Sets = &v
					sources.Sets = SourceInferred
				}
				if applied.Reps == nil && log.RepsCompleted != nil {
					v := *log.RepsCompleted
					applied.Reps = &v
					sources.Reps = SourceInferred
				}
				if applied.WeightKg == nil && log.WeightKg != nil {
					v := *log.WeightKg
					applied.WeightKg = &v
					sources.WeightKg = SourceInferred
				}
			}
		}
		plan.Applied = applied
		plan.Sources = sources
		// If after inference we still have nothing concrete to log, surface that
		// so the agent doesn't end up with a blank exercise log row.
		missing := missingFields(applied)
		if len(missing) > 0 {
			plan.Status = StatusMissingDefaults
			plan.Missing = missing
			plan.Hint = fmt.Sprintf("no prior log for %q to infer from; provide %s", resolved, strings.Join(missing, "/"))
			return plan, nil
		}
		plan.Status = StatusResolved
		return plan, nil

	case matchAmbiguous:
		plan.Status = StatusAmbiguous
		plan.Candidates = candidates
		plan.Hint = fmt.Sprintf("re-send with one of: %s", strings.Join(candidates, ", "))
		return plan, nil

	default: // matchNone
		// No catalog match. If the agent supplied enough numbers we can create
		// a brand-new exercise name from the literal input. Otherwise it's a
		// missing-defaults error so the agent can self-correct.
		applied, sources := mergePayloadValues(input)
		missing := missingFields(applied)
		if len(missing) == 0 {
			plan.ResolvedName = trimmed
			plan.Applied = applied
			plan.Sources = sources
			plan.Status = StatusCreateNew
			return plan, nil
		}
		plan.Status = StatusMissingDefaults
		plan.Missing = missing
		plan.Hint = fmt.Sprintf("no prior log for %q; provide %s", trimmed, strings.Join(missing, "/"))
		return plan, nil
	}
}

// matchKind is the verdict from resolveName.
type matchKind int

const (
	matchNone matchKind = iota
	matchExact
	matchSingleFuzzy
	matchAmbiguous
)

// resolveName implements the matching policy:
//  1. Exact case-insensitive equality.
//  2. Substring containment (input ⊆ catalog item OR catalog item ⊆ input).
//  3. Levenshtein distance ≤ 2 against catalog.
//
// Within steps 2 and 3, if exactly one match wins → resolved. >1 → ambiguous.
func resolveName(input string, catalog []string) (resolved string, candidates []string, kind matchKind) {
	if len(catalog) == 0 {
		return "", nil, matchNone
	}
	low := strings.ToLower(strings.TrimSpace(input))

	// 1. Exact match.
	for _, name := range catalog {
		if strings.ToLower(name) == low {
			return name, nil, matchExact
		}
	}

	// 2. Substring containment.
	var subMatches []string
	seen := make(map[string]bool)
	for _, name := range catalog {
		ln := strings.ToLower(name)
		if strings.Contains(ln, low) || strings.Contains(low, ln) {
			if !seen[ln] {
				seen[ln] = true
				subMatches = append(subMatches, name)
			}
		}
	}
	if len(subMatches) == 1 {
		return subMatches[0], nil, matchSingleFuzzy
	}
	if len(subMatches) > 1 {
		sort.Strings(subMatches)
		return "", subMatches, matchAmbiguous
	}

	// 3. Levenshtein ≤ 2.
	var lvMatches []string
	for _, name := range catalog {
		if levenshtein(low, strings.ToLower(name)) <= 2 {
			lvMatches = append(lvMatches, name)
		}
	}
	if len(lvMatches) == 1 {
		return lvMatches[0], nil, matchSingleFuzzy
	}
	if len(lvMatches) > 1 {
		sort.Strings(lvMatches)
		return "", lvMatches, matchAmbiguous
	}

	return "", nil, matchNone
}

// mergePayloadValues combines flat fields and per_set arrays into applied values.
// When per_set is present it wins for sets/reps/weight aggregation; the flat
// fields are still consulted for duration_minutes (per_set has no duration).
//
// Within per_set, only entries that explicitly supplied a field contribute to
// the max. If every entry omits reps (or weight_kg), the aggregate stays nil
// so the inference step can fill it from history — distinguishing "omitted"
// from "explicit zero" prevents corrupting stats for weighted exercises.
func mergePayloadValues(input ResolverInput) (AppliedValues, FieldSources) {
	var applied AppliedValues
	var sources FieldSources

	if len(input.PerSet) > 0 {
		setsCount := len(input.PerSet)
		applied.Sets = &setsCount
		sources.Sets = SourcePerSet

		var maxReps int
		var maxW float64
		repsSeen, weightSeen := false, false
		for _, e := range input.PerSet {
			if e.Reps != nil {
				if !repsSeen || *e.Reps > maxReps {
					maxReps = *e.Reps
				}
				repsSeen = true
			}
			if e.WeightKg != nil {
				if !weightSeen || *e.WeightKg > maxW {
					maxW = *e.WeightKg
				}
				weightSeen = true
			}
		}
		// per_set is authoritative for the fields it supplies. Zero is allowed
		// (bodyweight exercises send weight_kg=0); fully-omitted fields stay
		// nil so the inference step can fill them.
		if repsSeen {
			r := maxReps
			applied.Reps = &r
			sources.Reps = SourcePerSet
		}
		if weightSeen {
			wt := maxW
			applied.WeightKg = &wt
			sources.WeightKg = SourcePerSet
		}
	} else {
		if input.Sets != nil {
			v := *input.Sets
			applied.Sets = &v
			sources.Sets = SourceAgent
		}
		if input.Reps != nil {
			v := *input.Reps
			applied.Reps = &v
			sources.Reps = SourceAgent
		}
		if input.WeightKg != nil {
			v := *input.WeightKg
			applied.WeightKg = &v
			sources.WeightKg = SourceAgent
		}
	}

	if input.DurationMinutes != nil {
		v := *input.DurationMinutes
		applied.DurationMinutes = &v
	}

	return applied, sources
}

// missingFields returns the names of strength fields that are still nil after
// merging payload + inference. Cardio-only payloads (duration set, sets/reps
// nil, no per_set) are valid and return an empty slice.
func missingFields(a AppliedValues) []string {
	if a.DurationMinutes != nil && a.Sets == nil && a.Reps == nil && a.WeightKg == nil {
		return nil
	}
	var missing []string
	if a.Sets == nil {
		missing = append(missing, "sets")
	}
	if a.Reps == nil {
		missing = append(missing, "reps")
	}
	if a.WeightKg == nil {
		missing = append(missing, "weight_kg")
	}
	return missing
}

// levenshtein returns the edit distance between a and b. Implementation is
// the classic two-row DP; small enough for inline use.
func levenshtein(a, b string) int {
	if a == b {
		return 0
	}
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	curr := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			del := prev[j] + 1
			ins := curr[j-1] + 1
			sub := prev[j-1] + cost
			curr[j] = min3(del, ins, sub)
		}
		prev, curr = curr, prev
	}
	return prev[lb]
}

func min3(a, b, c int) int {
	m := a
	if b < m {
		m = b
	}
	if c < m {
		m = c
	}
	return m
}
