package mcp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestNewOAuthHandler(t *testing.T) {
	cfg := &Config{
		AllowedSubject: "test-user",
		MCPServerURL:   "https://mcp.example.com",
		ClientID:       "test-client",
	}

	handler := NewOAuthHandler(cfg)

	if handler == nil {
		t.Fatal("NewOAuthHandler returned nil")
	}

	if handler.config != cfg {
		t.Errorf("expected config to be %p, got %p", cfg, handler.config)
	}

	if handler.jwksCache == nil {
		t.Fatal("expected jwksCache to be initialized")
	}

	if handler.jwksCache.keys == nil {
		t.Error("expected jwksCache.keys map to be initialized")
	}

	if handler.jwksCache.ttl != 1*time.Hour {
		t.Errorf("expected jwksCache.ttl to be 1 hour, got %v", handler.jwksCache.ttl)
	}

	if handler.httpClient == nil {
		t.Fatal("expected httpClient to be initialized")
	}

	if handler.httpClient.Timeout != 30*time.Second {
		t.Errorf("expected httpClient.Timeout to be 30 seconds, got %v", handler.httpClient.Timeout)
	}
}

func TestIsSubjectAllowed(t *testing.T) {
	tests := []struct {
		name           string
		allowedSubject string
		subject        string
		want           bool
	}{
		{
			name:           "empty allows any subject",
			allowedSubject: "",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "single exact match",
			allowedSubject: "user-a",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "single mismatch",
			allowedSubject: "user-a",
			subject:        "user-b",
			want:           false,
		},
		{
			name:           "comma separated match first",
			allowedSubject: "user-a,user-b",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "comma separated match second with spaces",
			allowedSubject: "user-a, user-b",
			subject:        "user-b",
			want:           true,
		},
		{
			name:           "comma separated no match",
			allowedSubject: "user-a, user-b",
			subject:        "user-c",
			want:           false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OAuthHandler{
				config: &Config{
					AllowedSubject: tt.allowedSubject,
				},
			}

			got := h.isSubjectAllowed(tt.subject)
			if got != tt.want {
				t.Fatalf("isSubjectAllowed(%q) = %v, want %v", tt.subject, got, tt.want)
			}
		})
	}
}

func TestIsAudienceAllowed(t *testing.T) {
	tests := []struct {
		name        string
		serverURL   string
		clientIDs   string
		aud         string
		wantAllowed bool
	}{
		{
			name:        "matches server url",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a",
			aud:         "https://mcp.example.com",
			wantAllowed: true,
		},
		{
			name:        "matches single client id",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a",
			aud:         "client-a",
			wantAllowed: true,
		},
		{
			name:        "matches one of multiple client ids",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a, client-b",
			aud:         "client-b",
			wantAllowed: true,
		},
		{
			name:        "no match",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a, client-b",
			aud:         "client-c",
			wantAllowed: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OAuthHandler{
				config: &Config{
					MCPServerURL: tt.serverURL,
					ClientID:     tt.clientIDs,
				},
			}

			got := h.isAudienceAllowed(tt.aud)
			if got != tt.wantAllowed {
				t.Fatalf("isAudienceAllowed(%q) = %v, want %v", tt.aud, got, tt.wantAllowed)
			}
		})
	}
}

func TestValidateToken_IssuerEnforcement(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	publicKey := &privateKey.PublicKey

	cfg := &Config{
		PocketIDURL:  "https://expected-issuer.com",
		MCPServerURL: "https://mcp.example.com",
		ClientID:     "test-client",
	}
	h := NewOAuthHandler(cfg)
	// Inject the public key into the cache
	h.jwksCache.keys["test-kid"] = publicKey
	h.jwksCache.lastUpdate = time.Now()

	t.Run("Wrong Issuer", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"iss": "https://wrong-issuer.com",
			"sub": "user123",
			"aud": "https://mcp.example.com",
			"exp": time.Now().Add(time.Hour).Unix(),
		})
		token.Header["kid"] = "test-kid"
		tokenString, err := token.SignedString(privateKey)
		if err != nil {
			t.Fatalf("failed to sign token: %v", err)
		}

		_, err = h.validateToken(context.Background(), tokenString)
		if err == nil {
			t.Errorf("Expected error for wrong issuer, but got nil")
		}
	})

	t.Run("Correct Issuer", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"iss": "https://expected-issuer.com",
			"sub": "user123",
			"aud": "https://mcp.example.com",
			"exp": time.Now().Add(time.Hour).Unix(),
		})
		token.Header["kid"] = "test-kid"
		tokenString, err := token.SignedString(privateKey)
		if err != nil {
			t.Fatalf("failed to sign token: %v", err)
		}

		subject, err := h.validateToken(context.Background(), tokenString)
		if err != nil {
			t.Errorf("Expected no error for correct issuer, but got: %v", err)
		}
		if subject != "user123" {
			t.Errorf("Expected subject 'user123', got %q", subject)
		}
	})
}

func TestHandleProtectedResourceMetadata(t *testing.T) {
	cfg := &Config{
		MCPServerURL: "https://mcp.example.com",
		PocketIDURL:  "https://auth.example.com",
	}
	h := NewOAuthHandler(cfg)

	req, err := http.NewRequest("GET", "/.well-known/oauth-protected-resource", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	rr := httptest.NewRecorder()
	h.HandleProtectedResourceMetadata(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
	}

	contentType := rr.Header().Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("handler returned wrong content type: got %v want %v", contentType, "application/json")
	}

	var metadata ProtectedResourceMetadata
	if err := json.NewDecoder(rr.Body).Decode(&metadata); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if metadata.Resource != cfg.MCPServerURL {
		t.Errorf("expected Resource %q, got %q", cfg.MCPServerURL, metadata.Resource)
	}

	if len(metadata.AuthorizationServers) != 1 || metadata.AuthorizationServers[0] != cfg.PocketIDURL {
		t.Errorf("expected AuthorizationServers to contain %q, got %v", cfg.PocketIDURL, metadata.AuthorizationServers)
	}

	expectedScopes := []string{"openid", "profile"}
	if len(metadata.ScopesSupported) != len(expectedScopes) {
		t.Errorf("expected ScopesSupported length %d, got %d", len(expectedScopes), len(metadata.ScopesSupported))
	} else {
		for i, scope := range expectedScopes {
			if metadata.ScopesSupported[i] != scope {
				t.Errorf("expected ScopesSupported[%d] = %q, got %q", i, scope, metadata.ScopesSupported[i])
			}
		}
	}
}
