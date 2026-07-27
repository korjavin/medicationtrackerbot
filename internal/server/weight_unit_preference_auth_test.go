// Tests that depend on the auth boundary (401 for unauthenticated requests).

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleSetWeightUnitPreference_UnauthenticatedRejected(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	handler := srv.Routes()

	body, _ := json.Marshal(map[string]string{"unit": "lb"})
	req := httptest.NewRequest("PATCH", "/api/settings/weight-unit", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without auth, got %d (body: %s)", w.Code, w.Body.String())
	}

	// Stored preference must remain at the default.
	got, err := db.Weight.GetUnitPreference(context.Background())
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if got != "kg" {
		t.Fatalf("expected stored preference still 'kg' after unauthenticated request, got %q", got)
	}
}
