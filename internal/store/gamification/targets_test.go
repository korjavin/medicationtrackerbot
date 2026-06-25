package gamification

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// setupRepo mounts the embedded schema into an in-memory DB and returns a Repo
// with a fixed clock so updated_at stamps are deterministic.
func setupRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	r := New(d)
	fixed := time.Unix(1750809600, 0).UTC() // 2025-06-25 00:00:00 UTC
	r.SetClock(func() time.Time { return fixed })
	return r
}

func f64(v float64) *float64 { return &v }

func TestListTargets_Empty(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	got, err := r.ListTargets(ctx, 1)
	if err != nil {
		t.Fatalf("ListTargets: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 targets for fresh user, got %d", len(got))
	}
}

func TestUpsertTarget_Insert(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	out, err := r.UpsertTarget(ctx, 1, Target{
		MetricKey: "sleep_hours",
		LowVal:    f64(7),
		HighVal:   f64(9),
		Falloff:   f64(1),
		Mode:      "range",
	})
	if err != nil {
		t.Fatalf("UpsertTarget: %v", err)
	}
	if out.ID == 0 {
		t.Error("expected non-zero ID")
	}
	if out.UserID != 1 {
		t.Errorf("user_id = %d, want 1", out.UserID)
	}
	if out.MetricKey != "sleep_hours" {
		t.Errorf("metric_key = %q, want sleep_hours", out.MetricKey)
	}
	if out.LowVal == nil || *out.LowVal != 7 {
		t.Errorf("low_val = %v, want 7", out.LowVal)
	}
	if out.HighVal == nil || *out.HighVal != 9 {
		t.Errorf("high_val = %v, want 9", out.HighVal)
	}
	if out.Falloff == nil || *out.Falloff != 1 {
		t.Errorf("falloff = %v, want 1", out.Falloff)
	}
	if out.Mode != "range" {
		t.Errorf("mode = %q, want range", out.Mode)
	}
	if out.UpdatedAt.Unix() != 1750809600 {
		t.Errorf("updated_at = %v, want 2025-06-25 00:00:00 UTC", out.UpdatedAt)
	}

	// Round-trip through ListTargets.
	list, err := r.ListTargets(ctx, 1)
	if err != nil {
		t.Fatalf("ListTargets: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 target, got %d", len(list))
	}
	if list[0].ID != out.ID || list[0].MetricKey != "sleep_hours" {
		t.Errorf("listed target mismatch: %+v", list[0])
	}
}

func TestUpsertTarget_NullableFields(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	// One-sided target: only a high bound, no falloff, no mode → NULL columns
	// must round-trip back to nil pointers / "".
	out, err := r.UpsertTarget(ctx, 1, Target{
		MetricKey: "resting_hr",
		HighVal:   f64(70),
	})
	if err != nil {
		t.Fatalf("UpsertTarget: %v", err)
	}
	if out.LowVal != nil {
		t.Errorf("low_val = %v, want nil", *out.LowVal)
	}
	if out.HighVal == nil || *out.HighVal != 70 {
		t.Errorf("high_val = %v, want 70", out.HighVal)
	}
	if out.Falloff != nil {
		t.Errorf("falloff = %v, want nil", *out.Falloff)
	}
	if out.Mode != "" {
		t.Errorf("mode = %q, want empty", out.Mode)
	}
}

func TestUpsertTarget_ConflictReplacesPreservingID(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	first, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "calories", LowVal: f64(1800), HighVal: f64(2200), Mode: "range"})
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}

	// Same (user, metric_key) → ON CONFLICT updates the existing row in place.
	second, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "calories", LowVal: f64(1900), HighVal: f64(2300), Mode: "range"})
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("upsert replaced id: first=%d second=%d (want preserved)", first.ID, second.ID)
	}
	if second.LowVal == nil || *second.LowVal != 1900 {
		t.Errorf("low_val = %v, want updated 1900", second.LowVal)
	}

	// Exactly one row remains for that metric.
	list, err := r.ListTargets(ctx, 1)
	if err != nil {
		t.Fatalf("ListTargets: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 target after conflicting upsert, got %d", len(list))
	}
}

func TestListTargets_ScopedToUserAndOrdered(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	if _, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "sleep_hours", LowVal: f64(7)}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "calories", LowVal: f64(1800)}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.UpsertTarget(ctx, 2, Target{MetricKey: "weight", LowVal: f64(70)}); err != nil {
		t.Fatal(err)
	}

	list, err := r.ListTargets(ctx, 1)
	if err != nil {
		t.Fatalf("ListTargets: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 targets for user 1, got %d", len(list))
	}
	// Ordered by metric_key: calories < sleep_hours.
	if list[0].MetricKey != "calories" || list[1].MetricKey != "sleep_hours" {
		t.Errorf("targets not ordered by metric_key: %q, %q", list[0].MetricKey, list[1].MetricKey)
	}
}

func TestDeleteTarget(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	if _, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "sleep_hours", LowVal: f64(7)}); err != nil {
		t.Fatal(err)
	}

	if err := r.DeleteTarget(ctx, 1, "sleep_hours"); err != nil {
		t.Fatalf("DeleteTarget: %v", err)
	}

	list, err := r.ListTargets(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("expected 0 targets after delete, got %d", len(list))
	}
}

func TestDeleteTarget_Missing(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	err := r.DeleteTarget(ctx, 1, "nonexistent")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows deleting missing target, got %v", err)
	}
}

func TestDeleteTarget_WrongUser(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()

	if _, err := r.UpsertTarget(ctx, 1, Target{MetricKey: "sleep_hours", LowVal: f64(7)}); err != nil {
		t.Fatal(err)
	}

	// User 2 cannot delete user 1's target.
	err := r.DeleteTarget(ctx, 2, "sleep_hours")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows deleting another user's target, got %v", err)
	}
}
