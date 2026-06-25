package gamification

import (
	"context"
	"testing"
	"time"
)

// day returns the UTC-midnight time for a given calendar date — the canonical
// shape callers hand the ledger.
func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestUpsertLedger_Empty(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	if err := r.UpsertLedger(ctx, 1, nil); err != nil {
		t.Fatalf("UpsertLedger(nil): %v", err)
	}
	got, err := r.ListLedger(ctx, 1, 0, 1<<62)
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 rows after empty upsert, got %d", len(got))
	}
}

func TestUpsertLedger_RoundTrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	d := day(2025, 6, 25)

	entries := []LedgerEntry{
		{Day: d, Ring: "adherence", SourceMetric: "meds", Kind: "integrity_floor", HP: 10, Detail: `{"taken":3}`},
		{Day: d, Ring: "vitals", SourceMetric: "bp", Kind: "outcome_bonus", HP: 25},
	}
	if err := r.UpsertLedger(ctx, 7, entries); err != nil {
		t.Fatalf("UpsertLedger: %v", err)
	}

	got, err := r.ListLedger(ctx, 7, dayToUnix(d), dayToUnix(d))
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(got))
	}
	// Ordered by (day, ring, source_metric, kind): adherence < vitals.
	if got[0].Ring != "adherence" || got[1].Ring != "vitals" {
		t.Errorf("rows not ordered by ring: %q, %q", got[0].Ring, got[1].Ring)
	}
	first := got[0]
	if first.UserID != 7 {
		t.Errorf("user_id = %d, want 7", first.UserID)
	}
	if !first.Day.Equal(d) {
		t.Errorf("day = %v, want %v", first.Day, d)
	}
	if first.HP != 10 || first.Kind != "integrity_floor" || first.SourceMetric != "meds" {
		t.Errorf("unexpected row: %+v", first)
	}
	if first.Detail != `{"taken":3}` {
		t.Errorf("detail = %q, want json blob", first.Detail)
	}
	if first.CreatedAt.Unix() != 1750809600 {
		t.Errorf("created_at = %v, want fixed clock", first.CreatedAt)
	}
	// NULL detail round-trips to "".
	if got[1].Detail != "" {
		t.Errorf("expected empty detail for NULL column, got %q", got[1].Detail)
	}
}

func TestUpsertLedger_NormalizesDayToMidnight(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	// An instant mid-day must collapse onto the same day key as UTC-midnight so
	// the UNIQUE dedupe is timezone/instant-safe.
	noon := time.Date(2025, 6, 25, 13, 37, 5, 0, time.UTC)
	if err := r.UpsertLedger(ctx, 1, []LedgerEntry{
		{Day: noon, Ring: "mind", SourceMetric: "diary", Kind: "consistency_bonus", HP: 5},
	}); err != nil {
		t.Fatalf("UpsertLedger: %v", err)
	}
	got, err := r.ListLedger(ctx, 1, dayToUnix(day(2025, 6, 25)), dayToUnix(day(2025, 6, 25)))
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 row keyed on midnight, got %d", len(got))
	}
	if !got[0].Day.Equal(day(2025, 6, 25)) {
		t.Errorf("day not normalized to midnight: %v", got[0].Day)
	}
}

func TestUpsertLedger_IdempotentReplace(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	d := day(2025, 6, 25)
	key := LedgerEntry{Day: d, Ring: "adherence", SourceMetric: "meds", Kind: "integrity_floor"}

	// First award: 10 HP.
	first := key
	first.HP = 10
	if err := r.UpsertLedger(ctx, 1, []LedgerEntry{first}); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	// Re-score the same (day, ring, source_metric, kind) with a different HP →
	// must REPLACE the existing row, not add a second.
	second := key
	second.HP = 18
	if err := r.UpsertLedger(ctx, 1, []LedgerEntry{second}); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	got, err := r.ListLedger(ctx, 1, dayToUnix(d), dayToUnix(d))
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 row after idempotent re-score, got %d", len(got))
	}
	if got[0].HP != 18 {
		t.Errorf("hp = %d, want 18 (replaced)", got[0].HP)
	}

	// SumHP reflects the replacement, not the accumulation.
	sum, err := r.SumHP(ctx, 1)
	if err != nil {
		t.Fatalf("SumHP: %v", err)
	}
	if sum != 18 {
		t.Errorf("SumHP = %d, want 18", sum)
	}
}

func TestListLedger_RangeAndScope(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	d1, d2, d3 := day(2025, 6, 23), day(2025, 6, 24), day(2025, 6, 25)
	mk := func(d time.Time, hp int) LedgerEntry {
		return LedgerEntry{Day: d, Ring: "movement", SourceMetric: "steps", Kind: "outcome_bonus", HP: hp}
	}
	if err := r.UpsertLedger(ctx, 1, []LedgerEntry{mk(d1, 1), mk(d2, 2), mk(d3, 3)}); err != nil {
		t.Fatalf("seed user 1: %v", err)
	}
	// Another user's row must never leak into user 1's range read.
	if err := r.UpsertLedger(ctx, 2, []LedgerEntry{mk(d2, 99)}); err != nil {
		t.Fatalf("seed user 2: %v", err)
	}

	// Inclusive [d2, d3] excludes d1.
	got, err := r.ListLedger(ctx, 1, dayToUnix(d2), dayToUnix(d3))
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows in [d2,d3], got %d", len(got))
	}
	if !got[0].Day.Equal(d2) || !got[1].Day.Equal(d3) {
		t.Errorf("range not ordered/inclusive: %v, %v", got[0].Day, got[1].Day)
	}

	// SumHP is scoped per user and counts all days.
	if sum, _ := r.SumHP(ctx, 1); sum != 6 {
		t.Errorf("SumHP user 1 = %d, want 6", sum)
	}
	if sum, _ := r.SumHP(ctx, 2); sum != 99 {
		t.Errorf("SumHP user 2 = %d, want 99", sum)
	}
}

func TestSumHP_EmptyUser(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	sum, err := r.SumHP(ctx, 42)
	if err != nil {
		t.Fatalf("SumHP: %v", err)
	}
	if sum != 0 {
		t.Errorf("SumHP for user with no awards = %d, want 0", sum)
	}
}

func TestGetState_DefaultWhenAbsent(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	st, err := r.GetState(ctx, 5)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.UserID != 5 {
		t.Errorf("user_id = %d, want 5", st.UserID)
	}
	if st.Level != 1 {
		t.Errorf("default level = %d, want 1", st.Level)
	}
	if st.InsightTier != 1 {
		t.Errorf("default insight_tier = %d, want 1", st.InsightTier)
	}
	if st.LifetimeHP != 0 || st.CurrentStreak != 0 || st.LongestStreak != 0 || st.Freezes != 0 {
		t.Errorf("expected zero counters for absent state, got %+v", st)
	}
	if st.LastScoredDay != nil {
		t.Errorf("expected nil LastScoredDay for absent state, got %v", st.LastScoredDay)
	}
}

func TestUpsertState_RoundTripAndConflict(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	scored := day(2025, 6, 24)

	out, err := r.UpsertState(ctx, 1, State{
		LifetimeHP:    120,
		Level:         3,
		CurrentStreak: 4,
		LongestStreak: 9,
		Freezes:       2,
		InsightTier:   2,
		LastScoredDay: &scored,
	})
	if err != nil {
		t.Fatalf("UpsertState insert: %v", err)
	}
	if out.LifetimeHP != 120 || out.Level != 3 || out.CurrentStreak != 4 || out.LongestStreak != 9 || out.Freezes != 2 || out.InsightTier != 2 {
		t.Errorf("unexpected persisted state: %+v", out)
	}
	if out.LastScoredDay == nil || !out.LastScoredDay.Equal(scored) {
		t.Errorf("last_scored_day = %v, want %v", out.LastScoredDay, scored)
	}
	if out.UpdatedAt.Unix() != 1750809600 {
		t.Errorf("updated_at = %v, want fixed clock", out.UpdatedAt)
	}

	// Re-upsert (same user PK) updates in place; GetState reflects new values.
	if _, err := r.UpsertState(ctx, 1, State{LifetimeHP: 200, Level: 4, InsightTier: 3}); err != nil {
		t.Fatalf("UpsertState update: %v", err)
	}
	got, err := r.GetState(ctx, 1)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if got.LifetimeHP != 200 || got.Level != 4 || got.InsightTier != 3 {
		t.Errorf("state not updated in place: %+v", got)
	}
	if got.LastScoredDay != nil {
		t.Errorf("expected nil last_scored_day after update without it, got %v", got.LastScoredDay)
	}
}

func TestApplyDayScore_AtomicLedgerAndState(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	d := day(2025, 6, 25)

	entries := []LedgerEntry{
		{Day: d, Ring: "adherence", SourceMetric: "meds", Kind: "integrity_floor", HP: 10},
		{Day: d, Ring: "nourishment", SourceMetric: "food", Kind: "outcome_bonus", HP: 15},
	}
	state := State{LifetimeHP: 25, Level: 1, CurrentStreak: 1, LongestStreak: 1, InsightTier: 1, LastScoredDay: &d}

	out, err := r.ApplyDayScore(ctx, 1, d, entries, state)
	if err != nil {
		t.Fatalf("ApplyDayScore: %v", err)
	}
	if out.LifetimeHP != 25 || out.CurrentStreak != 1 {
		t.Errorf("returned state mismatch: %+v", out)
	}

	// Ledger written.
	led, err := r.ListLedger(ctx, 1, dayToUnix(d), dayToUnix(d))
	if err != nil {
		t.Fatalf("ListLedger: %v", err)
	}
	if len(led) != 2 {
		t.Fatalf("expected 2 ledger rows, got %d", len(led))
	}
	if sum, _ := r.SumHP(ctx, 1); sum != 25 {
		t.Errorf("SumHP = %d, want 25 (matches lifetime_hp)", sum)
	}

	// State written and readable.
	got, err := r.GetState(ctx, 1)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if got.LifetimeHP != 25 || got.LastScoredDay == nil || !got.LastScoredDay.Equal(d) {
		t.Errorf("state not persisted by ApplyDayScore: %+v", got)
	}

	// Re-applying the same day is idempotent for the ledger (replace, not append).
	if _, err := r.ApplyDayScore(ctx, 1, d, entries, state); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	led2, _ := r.ListLedger(ctx, 1, dayToUnix(d), dayToUnix(d))
	if len(led2) != 2 {
		t.Errorf("expected 2 ledger rows after re-apply, got %d", len(led2))
	}
}

// TestApplyDayScore_ReplacesWholeDay verifies a re-score with FEWER awards drops
// the day's stale rows instead of orphaning them, keeping SumHP consistent with
// the supplied state.
func TestApplyDayScore_ReplacesWholeDay(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	d := day(2025, 6, 25)

	first := []LedgerEntry{
		{Day: d, Ring: "adherence", SourceMetric: "meds", Kind: "floor", HP: 10},
		{Day: d, Ring: "vitals", SourceMetric: "bp", Kind: "outcome", HP: 15},
	}
	if _, err := r.ApplyDayScore(ctx, 1, d, first, State{LifetimeHP: 25, Level: 1, InsightTier: 1, LastScoredDay: &d}); err != nil {
		t.Fatalf("ApplyDayScore #1: %v", err)
	}

	// Re-score with the bp outcome gone (e.g. the reading was deleted).
	second := []LedgerEntry{{Day: d, Ring: "adherence", SourceMetric: "meds", Kind: "floor", HP: 10}}
	if _, err := r.ApplyDayScore(ctx, 1, d, second, State{LifetimeHP: 10, Level: 1, InsightTier: 1, LastScoredDay: &d}); err != nil {
		t.Fatalf("ApplyDayScore #2: %v", err)
	}

	led, _ := r.ListLedger(ctx, 1, dayToUnix(d), dayToUnix(d))
	if len(led) != 1 {
		t.Fatalf("expected 1 ledger row after shrunk re-score, got %d (orphan not removed)", len(led))
	}
	if sum, _ := r.SumHP(ctx, 1); sum != 10 {
		t.Errorf("SumHP = %d after shrunk re-score, want 10 (no orphan HP)", sum)
	}
}
