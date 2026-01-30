package mcp

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ctxKey is a context key type for user info
type ctxKey string

const (
	UserSubjectCtxKey ctxKey = "user_subject"
)

// OAuthHandler handles OAuth-related endpoints and token validation
type OAuthHandler struct {
	config     *Config
	jwksCache  *JWKSCache
	httpClient *http.Client
}

// JWKSCache caches JWKS (JSON Web Key Set) for token validation
type JWKSCache struct {
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastUpdate time.Time
	ttl        time.Duration
}

// NewOAuthHandler creates a new OAuth handler
func NewOAuthHandler(cfg *Config) *OAuthHandler {
	return &OAuthHandler{
		config: cfg,
		jwksCache: &JWKSCache{
			keys: make(map[string]*rsa.PublicKey),
			ttl:  1 * time.Hour,
		},
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ProtectedResourceMetadata represents OAuth 2.0 Protected Resource Metadata (RFC9728)
type ProtectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported,omitempty"`
}

// HandleProtectedResourceMetadata returns the OAuth Protected Resource Metadata
func (h *OAuthHandler) HandleProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	metadata := ProtectedResourceMetadata{
		Resource:             h.config.MCPServerURL,
		AuthorizationServers: []string{h.config.PocketIDURL},
		ScopesSupported:      []string{"openid", "profile"},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(metadata)
}

// Middleware validates OAuth tokens and extracts user info
func (h *OAuthHandler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract Bearer token from Authorization header
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			h.sendUnauthorized(w, "missing Authorization header")
			return
		}

		if !strings.HasPrefix(authHeader, "Bearer ") {
			h.sendUnauthorized(w, "invalid Authorization header format")
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		// Validate the token
		subject, err := h.validateToken(r.Context(), tokenString)
		if err != nil {
			log.Printf("[MCP/OAuth] Token validation failed: %v", err)
			h.sendUnauthorized(w, "invalid token")
			return
		}

		// Check if the subject matches the allowed subject
		if subject != h.config.AllowedSubject {
			log.Printf("[MCP/OAuth] Subject %s not allowed (expected %s)", subject, h.config.AllowedSubject)
			h.sendForbidden(w, "user not authorized")
			return
		}

		log.Printf("[MCP/OAuth] Authorized request from subject: %s", subject)

		// Add subject to context
		ctx := context.WithValue(r.Context(), UserSubjectCtxKey, subject)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// validateToken validates a JWT token and returns the subject
func (h *OAuthHandler) validateToken(ctx context.Context, tokenString string) (string, error) {
	// Parse the token without validation to get the key ID
	parser := jwt.NewParser()
	token, _, err := parser.ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		return "", fmt.Errorf("failed to parse token: %w", err)
	}

	// Get the key ID from the token header
	kid, ok := token.Header["kid"].(string)
	if !ok {
		return "", fmt.Errorf("token missing kid header")
	}

	// Get the public key from JWKS
	publicKey, err := h.getPublicKey(ctx, kid)
	if err != nil {
		return "", fmt.Errorf("failed to get public key: %w", err)
	}

	// Parse and validate the token with the public key
	validToken, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		// Verify signing method is RSA
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return publicKey, nil
	}, jwt.WithExpirationRequired())

	if err != nil {
		// Debug logging for claims comparison
		if claims, ok := token.Claims.(jwt.MapClaims); ok {
			log.Printf("[MCP/OAuth] Configured Audience (MCP_SERVER_URL): %s", h.config.MCPServerURL)
			if aud, ok := claims["aud"]; ok {
				log.Printf("[MCP/OAuth] Token Audience (aud): %v", aud)
			} else {
				log.Printf("[MCP/OAuth] Token Audience (aud) claim missing")
			}
			if sub, ok := claims["sub"]; ok {
				log.Printf("[MCP/OAuth] Token Subject (sub): %v", sub)
			}
		}
		return "", fmt.Errorf("token validation failed: %w", err)
	}

	claims, ok := validToken.Claims.(jwt.MapClaims)
	if !ok {
		return "", fmt.Errorf("invalid claims type")
	}

	// Manual Audience Validation
	// We allow audience to be either the MCP Server URL OR the Client ID
	// (Pocket-ID often uses Client ID as audience for access tokens)
	audClaim, err := validToken.Claims.GetAudience()
	if err != nil {
		return "", fmt.Errorf("invalid audience claim: %w", err)
	}

	validAudience := false
	for _, aud := range audClaim {
		if aud == h.config.MCPServerURL || aud == h.config.ClientID {
			validAudience = true
			break
		}
	}

	if !validAudience {
		// Log actual audiences for debugging
		log.Printf("[MCP/OAuth] Audience Validation Failed. Expected '%s' or '%s'. Got: %v",
			h.config.MCPServerURL, h.config.ClientID, audClaim)
		return "", fmt.Errorf("token audience mismatch")
	}

	subject, ok := claims["sub"].(string)
	if !ok {
		return "", fmt.Errorf("missing sub claim")
	}

	return subject, nil
}

// getPublicKey retrieves the public key for the given key ID from JWKS
func (h *OAuthHandler) getPublicKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	h.jwksCache.mu.RLock()
	if key, ok := h.jwksCache.keys[kid]; ok && time.Since(h.jwksCache.lastUpdate) < h.jwksCache.ttl {
		h.jwksCache.mu.RUnlock()
		return key, nil
	}
	h.jwksCache.mu.RUnlock()

	// Refresh JWKS
	if err := h.refreshJWKS(ctx); err != nil {
		return nil, err
	}

	h.jwksCache.mu.RLock()
	defer h.jwksCache.mu.RUnlock()

	key, ok := h.jwksCache.keys[kid]
	if !ok {
		return nil, fmt.Errorf("key %s not found in JWKS", kid)
	}

	return key, nil
}

// JWKS represents a JSON Web Key Set
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// JWK represents a JSON Web Key
type JWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"` // RSA modulus
	E   string `json:"e"` // RSA exponent
}

// refreshJWKS fetches and caches the JWKS from Pocket-ID
func (h *OAuthHandler) refreshJWKS(ctx context.Context) error {
	jwksURL := h.config.PocketIDURL + "/.well-known/jwks.json"

	// Try to fetch from URL
	req, err := http.NewRequestWithContext(ctx, "GET", jwksURL, nil)
	var jwksData []byte

	if err == nil {
		resp, err := h.httpClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				jwksData, _ = io.ReadAll(resp.Body)
			} else {
				log.Printf("[MCP/OAuth] JWKS fetch returned %d", resp.StatusCode)
			}
		} else {
			log.Printf("[MCP/OAuth] JWKS fetch failed: %v", err)
		}
	}

	// Fallback to static JSON if fetch failed
	if len(jwksData) == 0 {
		if h.config.JWKSJSON != "" {
			log.Println("[MCP/OAuth] Using static JWKS fallback")
			jwksData = []byte(h.config.JWKSJSON)
		} else {
			return fmt.Errorf("failed to fetch JWKS and no fallback provided")
		}
	}

	var jwks JWKS
	if err := json.Unmarshal(jwksData, &jwks); err != nil {
		return fmt.Errorf("failed to decode JWKS: %w", err)
	}

	h.jwksCache.mu.Lock()
	defer h.jwksCache.mu.Unlock()

	// Parse and cache all RSA keys
	for _, jwk := range jwks.Keys {
		if jwk.Kty != "RSA" {
			continue
		}

		publicKey, err := parseRSAPublicKey(jwk.N, jwk.E)
		if err != nil {
			log.Printf("[MCP/OAuth] Failed to parse key %s: %v", jwk.Kid, err)
			continue
		}

		h.jwksCache.keys[jwk.Kid] = publicKey
	}

	h.jwksCache.lastUpdate = time.Now()
	log.Printf("[MCP/OAuth] Refreshed JWKS, cached %d keys", len(h.jwksCache.keys))

	return nil
}

// parseRSAPublicKey parses an RSA public key from base64url-encoded modulus and exponent
func parseRSAPublicKey(nBase64, eBase64 string) (*rsa.PublicKey, error) {
	// Decode modulus
	nBytes, err := jwt.NewParser().DecodeSegment(nBase64)
	if err != nil {
		return nil, fmt.Errorf("failed to decode modulus: %w", err)
	}

	// Decode exponent
	eBytes, err := jwt.NewParser().DecodeSegment(eBase64)
	if err != nil {
		return nil, fmt.Errorf("failed to decode exponent: %w", err)
	}

	// Convert exponent bytes to int
	var e int
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}

	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: e,
	}, nil
}

func (h *OAuthHandler) sendUnauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s"`, h.config.MCPServerURL))
	http.Error(w, msg, http.StatusUnauthorized)
}

func (h *OAuthHandler) sendForbidden(w http.ResponseWriter, msg string) {
	http.Error(w, msg, http.StatusForbidden)
}
