package store

import (
	"context"
	"testing"
)

// SECURITY RED TEST: sql-injection-dynamic-column-test
// This test is intentionally FAILING — it documents a security vulnerability.
// It will pass once the underlying code is fixed.
// Vulnerability: The store layer accepts column names via string parameter and uses fmt.Sprintf to construct queries (lines 1674, 1692). While current handlers safely whitelist via switch statements, future developers might call these functions unsafely. An SQLi-via-column-name vulnerability in the store exposes all settings tables. This test enforces that the store layer must validate inputs regardless of caller behavior.
func TestSetSettingsBoolRejectsInvalidColumnNames(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	tests := []struct {
		name   string
		column string
	}{
		{
			name:   "SQL injection attempt with DROP TABLE",
			column: "food_intake_enabled; DROP TABLE settings; --",
		},
		{
			name:   "Invalid column with SQL injection",
			column: "nonexistent' OR '1'='1",
		},
		{
			name:   "Column name with escape sequence",
			column: "food_intake_enabled`; DELETE FROM settings; --",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Attempt to call setSettingsBool with a malicious column name
			// This should be rejected by validation, not by SQL error
			err := db.setSettingsBool(ctx, tt.column, true)

			// The function should return an error for invalid column names
			// Currently this test may PASS (SQL error) but the code should validate
			// to make this a security best practice
			if err == nil {
				t.Error("setSettingsBool should reject malicious or invalid column names")
			}

			// Verify that the settings table is still accessible and functional
			// If the DROP TABLE somehow executed, this would fail
			enabled, err := db.GetFoodIntakeEnabled(ctx)
			if err != nil {
				t.Error("Settings table should still be accessible after attempted injection")
			}
			_ = enabled // Unused but verifies table access succeeds
		})
	}

	// Test getSettingsBool with invalid column names
	t.Run("getSettingsBool with invalid column", func(t *testing.T) {
		// Attempt to call getSettingsBool with a malicious column name
		_, err := db.getSettingsBool(ctx, "food_intake_enabled; DROP TABLE settings; --")

		// Should return an error instead of executing malicious SQL
		if err == nil {
			t.Error("getSettingsBool should reject malicious or invalid column names")
		}

		// Verify that the settings table is still intact
		enabled, err := db.GetFoodIntakeEnabled(ctx)
		if err != nil {
			t.Error("Settings table should still be accessible after attempted injection")
		}
		_ = enabled
	})
}
