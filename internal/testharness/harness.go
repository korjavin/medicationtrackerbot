package testharness

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

// Scenario represents a single test case loaded from a JSON file.
type Scenario struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Input       json.RawMessage `json:"input,omitempty"`
	State       json.RawMessage `json:"state,omitempty"`
	Expected    json.RawMessage `json:"expected,omitempty"`
}

// LoadScenarios loads an array of scenarios from the specified JSON file.
func LoadScenarios(t *testing.T, filename string) []Scenario {
	t.Helper()

	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("Failed to read scenarios file %s: %v", filename, err)
	}

	var scenarios []Scenario
	if err := json.Unmarshal(data, &scenarios); err != nil {
		t.Fatalf("Failed to parse scenarios file %s: %v", filename, err)
	}

	return scenarios
}

// Diff compares actual vs expected JSON representations and returns a diff string.
// If they are equal, it returns an empty string.
func Diff(expected, actual interface{}) string {
	expJSON, _ := json.Marshal(expected)
	actJSON, _ := json.Marshal(actual)

	var expObj, actObj interface{}
	_ = json.Unmarshal(expJSON, &expObj)
	_ = json.Unmarshal(actJSON, &actObj)

	if reflect.DeepEqual(expObj, actObj) {
		return ""
	}

	expPretty, _ := json.MarshalIndent(expObj, "", "  ")
	actPretty, _ := json.MarshalIndent(actObj, "", "  ")

	return fmt.Sprintf("Expected:\n%s\n\nActual:\n%s", expPretty, actPretty)
}

// CompareJSON checks if actual matches expected after both are marshaled to JSON.
func CompareJSON(t *testing.T, expected, actual interface{}) {
	t.Helper()
	if diff := Diff(expected, actual); diff != "" {
		t.Errorf("Mismatch found:\n%s", diff)
	}
}

// Run is a helper function that runs a single scenario using a custom runner.
func Run(t *testing.T, s Scenario, runner func(t *testing.T, s Scenario)) {
	t.Run(s.Name, func(t *testing.T) {
		runner(t, s)
	})
}

// RunScenarios loads and runs all scenarios from a JSON file.
func RunScenarios(t *testing.T, filename string, runner func(t *testing.T, s Scenario)) {
	scenarios := LoadScenarios(t, filename)
	for _, s := range scenarios {
		Run(t, s, runner)
	}
}

// NormalizeJSON unmarshals data and marshals it back to return a canonical string representation.
func NormalizeJSON(t *testing.T, data []byte) string {
	t.Helper()
	var obj interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}
	normalized, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("Failed to marshal JSON: %v", err)
	}
	return string(normalized)
}

// RequireJSONEq compares two JSON strings and fails the test immediately if they differ.
func RequireJSONEq(t *testing.T, expected, actual string) {
	t.Helper()
	var expObj, actObj interface{}
	if err := json.Unmarshal([]byte(expected), &expObj); err != nil {
		t.Fatalf("Failed to unmarshal expected JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(actual), &actObj); err != nil {
		t.Fatalf("Failed to unmarshal actual JSON: %v", err)
	}

	if diff := Diff(expObj, actObj); diff != "" {
		t.Fatalf("Mismatch found:\n%s", diff)
	}
}
