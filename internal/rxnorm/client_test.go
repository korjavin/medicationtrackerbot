package rxnorm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// mockRxNormServer creates a test HTTP server that responds to RxNorm API paths.
func mockRxNormServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return ts
}

func TestSearchRxNorm_ExactMatch(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/REST/rxcui.json":
			json.NewEncoder(w).Encode(map[string]any{
				"idGroup": map[string]any{
					"rxnormId": []string{"198440"},
				},
			})
		case "/REST/rxcui/198440/properties.json":
			json.NewEncoder(w).Encode(map[string]any{
				"properties": map[string]any{
					"name": "Ibuprofen 200 MG Oral Tablet",
				},
			})
		default:
			http.NotFound(w, r)
		}
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	rxcui, name, err := c.SearchRxNorm("ibuprofen")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rxcui != "198440" {
		t.Errorf("expected rxcui '198440', got %q", rxcui)
	}
	if name != "Ibuprofen 200 MG Oral Tablet" {
		t.Errorf("expected normalized name, got %q", name)
	}
}

func TestSearchRxNorm_NotFound_FallsBackToApproximate(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/REST/rxcui.json":
			// Exact match returns empty
			json.NewEncoder(w).Encode(map[string]any{
				"idGroup": map[string]any{
					"rxnormId": []string{},
				},
			})
		case "/REST/approximateTerm.json":
			// Approximate match returns a candidate
			json.NewEncoder(w).Encode(map[string]any{
				"approximateGroup": map[string]any{
					"candidate": []map[string]any{
						{"rxcui": "41493", "score": "80"},
					},
				},
			})
		case "/REST/rxcui/41493/properties.json":
			json.NewEncoder(w).Encode(map[string]any{
				"properties": map[string]any{
					"name": "Aspirin",
				},
			})
		default:
			http.NotFound(w, r)
		}
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	rxcui, name, err := c.SearchRxNorm("asprin") // intentional typo
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rxcui != "41493" {
		t.Errorf("expected rxcui '41493', got %q", rxcui)
	}
	if name != "Aspirin" {
		t.Errorf("expected name 'Aspirin', got %q", name)
	}
}

func TestSearchRxNorm_NothingFound(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Both exact and approximate return empty
		switch r.URL.Path {
		case "/REST/rxcui.json":
			json.NewEncoder(w).Encode(map[string]any{"idGroup": map[string]any{}})
		case "/REST/approximateTerm.json":
			json.NewEncoder(w).Encode(map[string]any{"approximateGroup": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	rxcui, name, err := c.SearchRxNorm("notadrugxyz123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rxcui != "" || name != "" {
		t.Errorf("expected empty rxcui and name for unknown drug, got %q %q", rxcui, name)
	}
}

func TestSearchRxNorm_NetworkError(t *testing.T) {
	// Use an invalid URL to simulate a network error
	c := newWithBaseURLs("http://127.0.0.1:0", "http://127.0.0.1:0")
	_, _, err := c.SearchRxNorm("ibuprofen")
	if err == nil {
		t.Fatal("expected error for unreachable server")
	}
}

func TestSearchRxNorm_PropertiesFailureReturnsIDOnly(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/REST/rxcui.json":
			json.NewEncoder(w).Encode(map[string]any{
				"idGroup": map[string]any{
					"rxnormId": []string{"99999"},
				},
			})
		case "/REST/rxcui/99999/properties.json":
			// Simulate server error on properties lookup
			http.Error(w, "internal error", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	// Point interaction URL elsewhere so properties call fails but doesn't network-error
	rxcui, name, err := c.SearchRxNorm("testdrug")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rxcui != "99999" {
		t.Errorf("expected rxcui '99999', got %q", rxcui)
	}
	// Name should be empty since properties lookup returned error body (decode will fail)
	_ = name // may be empty or partial, we just don't want a panic
}

func TestCheckInteractions_NoInteractions(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"fullInteractionTypeGroup": []any{},
		})
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	warnings, err := c.CheckInteractions([]string{"198440", "41493"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("expected 0 warnings, got %d: %v", len(warnings), warnings)
	}
}

func TestCheckInteractions_WithInteraction(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"fullInteractionTypeGroup": []any{
				map[string]any{
					"fullInteractionType": []any{
						map[string]any{
							"interactionPair": []any{
								map[string]any{
									"interactionConcept": []any{
										map[string]any{
											"minConceptItem": map[string]any{
												"name":  "Ibuprofen",
												"rxcui": "198440",
											},
										},
										map[string]any{
											"minConceptItem": map[string]any{
												"name":  "Warfarin",
												"rxcui": "11289",
											},
										},
									},
									"description": "Increased bleeding risk",
								},
							},
						},
					},
				},
			},
		})
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	warnings, err := c.CheckInteractions([]string{"198440", "11289"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d: %v", len(warnings), warnings)
	}
	if warnings[0] == "" {
		t.Error("expected non-empty warning message")
	}
}

func TestCheckInteractions_Deduplication(t *testing.T) {
	// API returns the same pair twice; should deduplicate
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		pair := map[string]any{
			"interactionConcept": []any{
				map[string]any{"minConceptItem": map[string]any{"name": "DrugA", "rxcui": "1"}},
				map[string]any{"minConceptItem": map[string]any{"name": "DrugB", "rxcui": "2"}},
			},
			"description": "Some interaction",
		}
		json.NewEncoder(w).Encode(map[string]any{
			"fullInteractionTypeGroup": []any{
				map[string]any{
					"fullInteractionType": []any{
						map[string]any{"interactionPair": []any{pair, pair}},
					},
				},
			},
		})
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	warnings, err := c.CheckInteractions([]string{"1", "2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warnings) != 1 {
		t.Errorf("expected 1 warning (deduped), got %d: %v", len(warnings), warnings)
	}
}

func TestCheckInteractions_LessThanTwoRxCUIs(t *testing.T) {
	c := newWithBaseURLs("http://unused", "http://unused")
	warnings, err := c.CheckInteractions([]string{"198440"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if warnings != nil {
		t.Errorf("expected nil warnings for single rxcui, got %v", warnings)
	}
}

func TestCheckInteractions_NetworkError(t *testing.T) {
	c := newWithBaseURLs("http://127.0.0.1:0", "http://127.0.0.1:0")
	_, err := c.CheckInteractions([]string{"1", "2"})
	if err == nil {
		t.Fatal("expected error for unreachable server")
	}
}

func TestCheckInteractions_NonOKStatus(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	_, err := c.CheckInteractions([]string{"1", "2"})
	if err == nil {
		t.Fatal("expected error for non-200 status")
	}
}

func TestSearchApproximate_NetworkError(t *testing.T) {
	c := newWithBaseURLs("http://127.0.0.1:0", "http://127.0.0.1:0")
	rxcui := c.searchApproximate("ibuprofen")
	if rxcui != "" {
		t.Errorf("expected empty rxcui on network error, got %q", rxcui)
	}
}

func TestSearchApproximate_HTTPError(t *testing.T) {
	ts := mockRxNormServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "server error", http.StatusInternalServerError)
	})

	c := newWithBaseURLs(ts.URL, ts.URL)
	rxcui := c.searchApproximate("ibuprofen")
	if rxcui != "" {
		t.Errorf("expected empty rxcui on http error, got %q", rxcui)
	}
}
