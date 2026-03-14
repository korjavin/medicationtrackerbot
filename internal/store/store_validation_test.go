package store

import (
	"context"
	"strings"
	"testing"
)

func TestSettingsBoolValidation(t *testing.T) {
	st, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer st.Close()

	ctx := context.Background()

	// Test valid columns
	validColumns := []string{
		"food_intake_enabled",
		"blood_pressure_enabled",
		"weight_enabled",
		"medication_enabled",
		"workout_enabled",
		"health_enabled",
	}

	for _, col := range validColumns {
		err := st.setSettingsBool(ctx, col, true)
		if err != nil {
			t.Errorf("Expected success for setting %s, got: %v", col, err)
		}

		val, err := st.getSettingsBool(ctx, col)
		if err != nil {
			t.Errorf("Expected success for getting %s, got: %v", col, err)
		}
		if !val {
			t.Errorf("Expected %s to be true, got false", col)
		}
	}

	// Test invalid columns (SQL Injection attempts)
	invalidColumns := []string{
		"invalid_column",
		"1; DROP TABLE settings",
		"food_intake_enabled; SELECT 1",
		"",
	}

	for _, col := range invalidColumns {
		err := st.setSettingsBool(ctx, col, true)
		if err == nil {
			t.Errorf("Expected error for setting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}

		_, err = st.getSettingsBool(ctx, col)
		if err == nil {
			t.Errorf("Expected error for getting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}
	}
}
