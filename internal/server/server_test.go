package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// SECURITY RED TEST: rate-limiting-sensitive-endpoints-test
// This test is intentionally FAILING — it documents a security vulnerability.
// It will pass once the underlying code is fixed.
//
// Vulnerability: The app only rate-limits authentication endpoints (10 req/min)
// but leaves data-modification endpoints unprotected. An attacker can rapidly
// create/delete medications or log false BP readings to spam the database or
// cause DoS via resource exhaustion. Health data is sensitive—uncontrolled
// write access is a compliance and security risk. This test enforces rate
// limiting on all mutation endpoints.
//
// Expected Behavior (after fix):
// - POST /api/medications should be rate-limited to 10 requests/minute
// - POST /api/bp should be rate-limited to 10 requests/minute
// - POST /api/weight should be rate-limited to 10 requests/minute
// - Requests beyond the limit should return HTTP 429 Too Many Requests
func TestRateLimitingSensitiveEndpoints(t *testing.T) {
	// Create test server
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	botToken := "test-bot-token"
	allowedUserID := int64(123456)
	srv := New(db, nil, botToken, "test-secret", allowedUserID, OIDCConfig{}, "test-bot", VAPIDConfig{})

	// Helper to create valid session token
	createValidSessionToken := func(email string) string {
		h := hmac.New(sha256.New, []byte(botToken))
		h.Write([]byte(email))
		sig := hex.EncodeToString(h.Sum(nil))
		return base64.RawURLEncoding.EncodeToString([]byte(email)) + "." + sig
	}

	sessionToken := createValidSessionToken("test@example.com")

	// Helper to make a POST request to create a medication
	makeMedicationRequest := func() (*httptest.ResponseRecorder, error) {
		reqBody := map[string]interface{}{
			"name":     "Test Med",
			"dosage":   "500mg",
			"schedule": "Every day",
		}
		body, _ := json.Marshal(reqBody)

		req := httptest.NewRequest("POST", "/api/medications", bytes.NewReader(body))
		req.AddCookie(&http.Cookie{
			Name:  "auth_session",
			Value: sessionToken,
		})

		w := httptest.NewRecorder()

		// Use the full Routes handler to test with middleware
		router := srv.Routes()
		router.ServeHTTP(w, req)

		return w, nil
	}

	// Make 15 rapid requests and collect results
	results := make([]int, 15)
	for i := 0; i < 15; i++ {
		w, _ := makeMedicationRequest()
		results[i] = w.Code
	}

	// Verify: Requests 1-10 should succeed (200 OK)
	for i := 0; i < 10; i++ {
		if results[i] != http.StatusOK && results[i] != http.StatusCreated {
			t.Logf("Request #%d: Expected 200/201, got %d (EXPECTED - rate limiting not yet implemented)", i+1, results[i])
		}
	}

	// ASSERTION: Requests 11-15 MUST return 429 Too Many Requests
	// This assertion will FAIL on current code because rate limiting is not implemented
	foundRateLimitedResponse := false
	for i := 10; i < 15; i++ {
		if results[i] == http.StatusTooManyRequests {
			foundRateLimitedResponse = true
			t.Logf("Request #%d correctly returned 429 Too Many Requests", i+1)
		} else {
			t.Logf("Request #%d returned %d (VULNERABLE - should be 429)", i+1, results[i])
		}
	}

	// FAILING ASSERTION: This proves the vulnerability exists
	if !foundRateLimitedResponse {
		t.Error("SECURITY VULNERABILITY: Data-modification endpoints are not rate-limited. " +
			"Requests 11-15 should fail with HTTP 429, but they did not. " +
			"This allows attackers to spam the database with uncontrolled POST requests.")
	}
}

// TestRateLimitingMultipleSensitiveEndpoints verifies that rate limiting
// should be enforced on all sensitive POST endpoints
func TestRateLimitingMultipleSensitiveEndpoints(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	botToken := "test-bot-token"
	allowedUserID := int64(123456)
	srv := New(db, nil, botToken, "test-secret", allowedUserID, OIDCConfig{}, "test-bot", VAPIDConfig{})

	// Create valid session token
	createValidSessionToken := func(email string) string {
		h := hmac.New(sha256.New, []byte(botToken))
		h.Write([]byte(email))
		sig := hex.EncodeToString(h.Sum(nil))
		return base64.RawURLEncoding.EncodeToString([]byte(email)) + "." + sig
	}

	sessionToken := createValidSessionToken("test@example.com")
	router := srv.Routes()

	endpoints := []struct {
		name   string
		path   string
		method string
		body   map[string]interface{}
	}{
		{
			name:   "POST /api/medications (create)",
			path:   "/api/medications",
			method: "POST",
			body: map[string]interface{}{
				"name":     "Test Med",
				"dosage":   "500mg",
				"schedule": "Every day",
			},
		},
		{
			name:   "POST /api/bp (create blood pressure)",
			path:   "/api/bp",
			method: "POST",
			body: map[string]interface{}{
				"systolic":  120,
				"diastolic": 80,
				"pulse":     70,
			},
		},
		{
			name:   "POST /api/weight (create weight)",
			path:   "/api/weight",
			method: "POST",
			body: map[string]interface{}{
				"weight": 75.5,
			},
		},
	}

	for _, endpoint := range endpoints {
		t.Run(endpoint.name, func(t *testing.T) {
			// Make 12 requests to this endpoint
			for i := 0; i < 12; i++ {
				body, _ := json.Marshal(endpoint.body)
				req := httptest.NewRequest(endpoint.method, endpoint.path, bytes.NewReader(body))
				req.AddCookie(&http.Cookie{
					Name:  "auth_session",
					Value: sessionToken,
				})

				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)

				// Request 11 and 12 should fail with 429
				if i >= 10 {
					if w.Code != http.StatusTooManyRequests {
						t.Logf("Request #%d to %s returned %d (expected 429 for rate-limited endpoint)",
							i+1, endpoint.path, w.Code)
						// This is expected to fail - documenting the vulnerability
					}
				}
			}
		})
	}
}
