package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleBootstrap_IncludesWeightUnitPreferenceDefault(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	settings, ok := payload["settings"].(map[string]any)
	if !ok {
		t.Fatalf("expected settings object in bootstrap")
	}
	unit, ok := settings["weight_unit_preference"].(string)
	if !ok {
		t.Fatalf("expected weight_unit_preference string in bootstrap settings, got %#v", settings["weight_unit_preference"])
	}
	if unit != "kg" {
		t.Fatalf("expected default weight_unit_preference 'kg', got %q", unit)
	}
}

func TestHandleBootstrap_IncludesWeightUnitPreferenceAfterSet(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if err := db.Weight.SetUnitPreference(context.Background(), "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	settings, ok := payload["settings"].(map[string]any)
	if !ok {
		t.Fatalf("expected settings object in bootstrap")
	}
	unit, ok := settings["weight_unit_preference"].(string)
	if !ok || unit != "lb" {
		t.Fatalf("expected weight_unit_preference 'lb', got %#v", settings["weight_unit_preference"])
	}
}

func TestHandleSetWeightUnitPreference_SetKg(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// First set to lb so we can observe the change to kg.
	if err := db.Weight.SetUnitPreference(context.Background(), "lb"); err != nil {
		t.Fatalf("setup SetWeightUnitPreference: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"unit": "kg"})
	req := httptest.NewRequest("PATCH", "/api/settings/weight-unit", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleSetWeightUnitPreference(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	got, err := db.Weight.GetUnitPreference(context.Background())
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if got != "kg" {
		t.Fatalf("expected stored preference 'kg', got %q", got)
	}
}

func TestHandleSetWeightUnitPreference_SetLb(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"unit": "lb"})
	req := httptest.NewRequest("PATCH", "/api/settings/weight-unit", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleSetWeightUnitPreference(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	got, err := db.Weight.GetUnitPreference(context.Background())
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if got != "lb" {
		t.Fatalf("expected stored preference 'lb', got %q", got)
	}
}

func TestHandleSetWeightUnitPreference_RejectsInvalid(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	cases := []string{"", "KG", "kilograms", "pound", "oz", "true"}
	for _, c := range cases {
		body, _ := json.Marshal(map[string]string{"unit": c})
		req := httptest.NewRequest("PATCH", "/api/settings/weight-unit", bytes.NewReader(body))
		req = withUser(req, 123456)
		w := httptest.NewRecorder()
		srv.handleSetWeightUnitPreference(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("unit=%q: expected 400, got %d (body: %s)", c, w.Code, w.Body.String())
		}
	}

	// Stored preference should remain at the default.
	got, err := db.Weight.GetUnitPreference(context.Background())
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if got != "kg" {
		t.Fatalf("expected stored preference still 'kg' after rejected requests, got %q", got)
	}
}

func TestHandleSetWeightUnitPreference_RejectsInvalidJSON(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("PATCH", "/api/settings/weight-unit", strings.NewReader("not-json"))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleSetWeightUnitPreference(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON, got %d", w.Code)
	}
}

