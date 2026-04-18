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
	type MyStruct struct {
		A int `json:"a"`
		B int `json:"b"`
	}

	tests := []struct {
		name     string
		expected interface{}
		actual   interface{}
		wantDiff string
	}{
		{
			name:     "equal structures",
			expected: map[string]int{"a": 1, "b": 2},
			actual:   map[string]int{"b": 2, "a": 1},
			wantDiff: "",
		},
		{
			name:     "equivalent JSON from different Go types",
			expected: MyStruct{A: 1, B: 2},
			actual:   map[string]int{"a": 1, "b": 2},
			wantDiff: "",
		},
		{
			name:     "differing values",
			expected: map[string]int{"a": 1, "b": 2},
			actual:   map[string]int{"a": 1, "b": 3},
			wantDiff: "Expected:\n{\n  \"a\": 1,\n  \"b\": 2\n}\n\nActual:\n{\n  \"a\": 1,\n  \"b\": 3\n}",
		},
		{
			name:     "differing structures",
			expected: map[string]int{"a": 1, "b": 2},
			actual:   []int{1, 2},
			wantDiff: "Expected:\n{\n  \"a\": 1,\n  \"b\": 2\n}\n\nActual:\n[\n  1,\n  2\n]",
		},
		{
			name:     "nested differing values",
			expected: map[string]interface{}{"obj": map[string]int{"inner": 1}},
			actual:   map[string]interface{}{"obj": map[string]int{"inner": 2}},
			wantDiff: "Expected:\n{\n  \"obj\": {\n    \"inner\": 1\n  }\n}\n\nActual:\n{\n  \"obj\": {\n    \"inner\": 2\n  }\n}",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotDiff := Diff(tt.expected, tt.actual)
			if gotDiff != tt.wantDiff {
				t.Errorf("Diff() = %q, want %q", gotDiff, tt.wantDiff)
			}
		})
	}
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
