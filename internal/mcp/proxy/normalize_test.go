package proxy

import (
	"testing"
)

func TestClampListParams_HealthBPList_DefaultsAndCapAppliedWhenZero(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "0", "limit": "0"}, 90)
	if got["days"] != "30" {
		t.Errorf("days: expected default 30 for zero input, got %q", got["days"])
	}
	if got["limit"] != "100" {
		t.Errorf("limit: expected default 100 for zero input, got %q", got["limit"])
	}
}

func TestClampListParams_HealthBPList_CapsExceedingDays(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "365"}, 90)
	if got["days"] != "90" {
		t.Errorf("days: expected clamp to 90, got %q", got["days"])
	}
}

func TestClampListParams_HealthBPList_CapsExceedingLimit(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"limit": "999999"}, 90)
	if got["limit"] != "5000" {
		t.Errorf("limit: expected clamp to 5000, got %q", got["limit"])
	}
}

func TestClampListParams_HealthBPList_PreservesValidValues(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "7", "limit": "50"}, 90)
	if got["days"] != "7" {
		t.Errorf("days: expected to preserve 7, got %q", got["days"])
	}
	if got["limit"] != "50" {
		t.Errorf("limit: expected to preserve 50, got %q", got["limit"])
	}
}

func TestClampListParams_HealthBPList_PopulatesDefaultsWhenAbsent(t *testing.T) {
	got := clampListParams("health.bp.list", nil, 90)
	if got["days"] != "30" {
		t.Errorf("days: expected default 30, got %q", got["days"])
	}
	if got["limit"] != "100" {
		t.Errorf("limit: expected default 100, got %q", got["limit"])
	}
}

func TestClampListParams_HealthWeightList_SameClampingAsBP(t *testing.T) {
	got := clampListParams("health.weight.list", map[string]string{"days": "0", "limit": "0"}, 90)
	if got["days"] != "30" || got["limit"] != "100" {
		t.Errorf("expected weight list defaults; got days=%q limit=%q", got["days"], got["limit"])
	}
	got = clampListParams("health.weight.list", map[string]string{"days": "9999"}, 90)
	if got["days"] != "90" {
		t.Errorf("expected days clamp to 90, got %q", got["days"])
	}
}

func TestClampListParams_MedicationsHistory_DefaultsToThreeDays(t *testing.T) {
	got := clampListParams("medications.history", map[string]string{"days": "0"}, 90)
	if got["days"] != "3" {
		t.Errorf("expected days=3 default, got %q", got["days"])
	}
}

func TestClampListParams_HealthNotesList_LimitClamped(t *testing.T) {
	got := clampListParams("health.notes.list", map[string]string{"limit": "0"}, 90)
	if got["limit"] != "50" {
		t.Errorf("expected limit=50 default, got %q", got["limit"])
	}
	got = clampListParams("health.notes.list", map[string]string{"limit": "9999"}, 90)
	if got["limit"] != "200" {
		t.Errorf("expected limit clamp to 200, got %q", got["limit"])
	}
}

func TestClampListParams_HealthNotesList_DaysClampedToMaxQueryDays(t *testing.T) {
	got := clampListParams("health.notes.list", map[string]string{"days": "999999"}, 90)
	if got["days"] != "90" {
		t.Errorf("expected days clamp to 90, got %q", got["days"])
	}
	got = clampListParams("health.notes.list", map[string]string{}, 90)
	if got["days"] != "30" {
		t.Errorf("expected default days=30 when absent, got %q", got["days"])
	}
}

func TestClampListParams_FoodLogList_DaysClampedToMaxQueryDays(t *testing.T) {
	got := clampListParams("food.log.list", map[string]string{"days": "999999"}, 90)
	if got["days"] != "90" {
		t.Errorf("expected food.log.list days clamp to 90, got %q", got["days"])
	}
	got = clampListParams("food.log.list", map[string]string{}, 90)
	if got["days"] != "1" {
		t.Errorf("expected default days=1 when absent, got %q", got["days"])
	}
}

func TestClampListParams_FoodStatsRead_DaysClampedToMaxQueryDays(t *testing.T) {
	got := clampListParams("food.stats.read", map[string]string{"days": "999999"}, 90)
	if got["days"] != "90" {
		t.Errorf("expected food.stats.read days clamp to 90, got %q", got["days"])
	}
	got = clampListParams("food.stats.read", map[string]string{}, 90)
	if got["days"] != "7" {
		t.Errorf("expected default days=7 when absent, got %q", got["days"])
	}
}

func TestClampListParams_WorkoutsSessionsList_LimitClamped(t *testing.T) {
	got := clampListParams("workouts.sessions.list", map[string]string{"limit": "-1"}, 90)
	if got["limit"] != "30" {
		t.Errorf("expected default limit=30 for negative input, got %q", got["limit"])
	}
	got = clampListParams("workouts.sessions.list", map[string]string{"limit": "999999"}, 90)
	if got["limit"] != "500" {
		t.Errorf("expected limit clamp to 500, got %q", got["limit"])
	}
	got = clampListParams("workouts.sessions.list", map[string]string{}, 90)
	if got["limit"] != "30" {
		t.Errorf("expected default limit=30 when absent, got %q", got["limit"])
	}
}

func TestClampListParams_UnknownOp_ReturnsUnchanged(t *testing.T) {
	in := map[string]string{"days": "0", "limit": "0"}
	got := clampListParams("workouts.groups.list", in, 90)
	if got["days"] != "0" || got["limit"] != "0" {
		t.Errorf("unknown op should be untouched; got days=%q limit=%q", got["days"], got["limit"])
	}
}

func TestClampListParams_MaxQueryDaysZero_DisablesDaysCap(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "9999", "limit": "10"}, 0)
	if got["days"] != "9999" {
		t.Errorf("with maxQueryDays=0, expected days passthrough, got %q", got["days"])
	}
	if got["limit"] != "10" {
		t.Errorf("limit should still be clamped; got %q", got["limit"])
	}
}

func TestClampListParams_NegativeValuesCoercedToDefault(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "-5", "limit": "-1"}, 90)
	if got["days"] != "30" {
		t.Errorf("expected negative days to coerce to default, got %q", got["days"])
	}
	if got["limit"] != "100" {
		t.Errorf("expected negative limit to coerce to default, got %q", got["limit"])
	}
}

func TestClampListParams_GarbageInputCoercedToDefault(t *testing.T) {
	got := clampListParams("health.bp.list", map[string]string{"days": "abc", "limit": "xyz"}, 90)
	if got["days"] != "30" || got["limit"] != "100" {
		t.Errorf("expected garbage to coerce to defaults; got days=%q limit=%q", got["days"], got["limit"])
	}
}
