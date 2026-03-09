package testharness

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestLoadScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "example_scenarios.json")
	scenarios := LoadScenarios(t, filename)

	if len(scenarios) != 2 {
		t.Fatalf("Expected 2 scenarios, got %d", len(scenarios))
	}

	if scenarios[0].Name != "basic comparison" {
		t.Errorf("Expected first scenario name to be 'basic comparison', got %s", scenarios[0].Name)
	}

	if scenarios[1].Name != "array comparison" {
		t.Errorf("Expected second scenario name to be 'array comparison', got %s", scenarios[1].Name)
	}
}

func TestRunScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "example_scenarios.json")

	RunScenarios(t, filename, func(t *testing.T, s Scenario) {
		var input interface{}
		if len(s.Input) > 0 {
			if err := json.Unmarshal(s.Input, &input); err != nil {
				t.Fatalf("Failed to unmarshal input: %v", err)
			}
		}

		var expected interface{}
		if len(s.Expected) > 0 {
			if err := json.Unmarshal(s.Expected, &expected); err != nil {
				t.Fatalf("Failed to unmarshal expected: %v", err)
			}
		}

		// Use the CompareJSON helper
		CompareJSON(t, expected, input)
	})
}
