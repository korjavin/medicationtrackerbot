package mcp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
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
