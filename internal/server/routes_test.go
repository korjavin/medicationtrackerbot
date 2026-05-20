//go:build !mobile

// TestRoutesRegistration asserts the server-build auth boundary (401 for
// unauthenticated /api/ requests). The mobile build wires a LocalUserResolver
// that has no auth boundary by design, so this test is server-only.

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRoutesRegistration(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	handler := srv.Routes()

	// Store original working directory and restore it after test
	originalWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get current working directory: %v", err)
	}
	defer os.Chdir(originalWd)

	// We create a temp dir and then chdir into it, so the static handlers
	// reading "./web/static" will read from our temp dir rather than
	// overwriting or deleting actual project source code.
	tempDir := t.TempDir()
	err = os.Chdir(tempDir)
	if err != nil {
		t.Fatalf("failed to chdir to temp dir: %v", err)
	}

	// Create temporary mock static files in the temp directory
	testStaticDir := filepath.Join("web", "static")
	testIconsDir := filepath.Join(testStaticDir, "icons")

	// Create directories if they don't exist
	if err := os.MkdirAll(testIconsDir, 0o755); err != nil {
		t.Fatalf("failed to create mock static directories: %v", err)
	}

	// Helper function to create mock files
	createMockFile := func(path string) {
		if err := os.WriteFile(path, []byte("mock data"), 0o644); err != nil {
			t.Fatalf("failed to write mock file %s: %v", path, err)
		}
	}

	mockFiles := []string{
		filepath.Join(testStaticDir, "index.html"),
		filepath.Join(testStaticDir, "pitch.html"),
		filepath.Join(testIconsDir, "favicon.ico"),
		filepath.Join(testStaticDir, "sw.js"),
		filepath.Join(testStaticDir, "oidc-setup.html"),
	}

	for _, file := range mockFiles {
		createMockFile(file)
	}

	tests := []struct {
		name           string
		method         string
		path           string
		expectedStatus int
	}{
		{"Static Config JS", "GET", "/static/config.js", http.StatusOK},
		{"Service Worker", "GET", "/static/sw.js", http.StatusOK},
		{"Pitch Deck", "GET", "/pitch", http.StatusOK},
		{"Main Index", "GET", "/", http.StatusOK},
		{"Deep Link BP", "GET", "/bp_add", http.StatusOK},
		{"Favicon", "GET", "/favicon.ico", http.StatusOK},
		{"Unauthorized API", "GET", "/api/health/overview", http.StatusUnauthorized},
		{"Not Found Route Fallback to Index", "GET", "/not-found-route", http.StatusOK},
		{"OIDC Setup", "GET", "/oidc-setup", http.StatusOK},
		{"API Not Found (No Auth)", "GET", "/api/not-found", http.StatusUnauthorized},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != tc.expectedStatus {
				t.Errorf("expected status %d, got %d", tc.expectedStatus, rr.Code)
			}
		})
	}
}
