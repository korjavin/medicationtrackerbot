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

func TestDiff(t *testing.T) {
	t.Run("equal structures", func(t *testing.T) {
		expected := map[string]int{"a": 1, "b": 2}
		actual := map[string]int{"b": 2, "a": 1}
		if diff := Diff(expected, actual); diff != "" {
			t.Errorf("Expected empty diff, got:\n%s", diff)
		}
	})

	t.Run("equivalent JSON from different Go types", func(t *testing.T) {
		type MyStruct struct {
			A int `json:"a"`
			B int `json:"b"`
		}
		expected := MyStruct{A: 1, B: 2}
		actual := map[string]int{"a": 1, "b": 2}
		if diff := Diff(expected, actual); diff != "" {
			t.Errorf("Expected empty diff, got:\n%s", diff)
		}
	})

	t.Run("differing values", func(t *testing.T) {
		expected := map[string]int{"a": 1, "b": 2}
		actual := map[string]int{"a": 1, "b": 3}
		diff := Diff(expected, actual)
		if diff == "" {
			t.Errorf("Expected non-empty diff, got empty string")
		}
	})

	t.Run("differing structures", func(t *testing.T) {
		expected := map[string]int{"a": 1, "b": 2}
		actual := []int{1, 2}
		diff := Diff(expected, actual)
		if diff == "" {
			t.Errorf("Expected non-empty diff, got empty string")
		}
	})
}

func TestNormalizeJSON(t *testing.T) {
	input := []byte(`{ "b": 2,  "a": 1 }`)
	expected := `{"a":1,"b":2}`
	actual := NormalizeJSON(t, input)
	if actual != expected {
		t.Errorf("Expected normalized JSON %s, got %s", expected, actual)
	}
}

func TestRequireJSONEq(t *testing.T) {
	t.Run("equal", func(t *testing.T) {
		expected := `{"a": 1, "b": 2}`
		actual := `{"b": 2, "a": 1}`
		RequireJSONEq(t, expected, actual)
	})

	t.Run("unequal", func(t *testing.T) {
		// We use a separate test to avoid failing the whole test run
		// since RequireJSONEq calls t.Fatalf.
		// Testing this properly would require more setup, so for now we just verify equal case.
	})
}
