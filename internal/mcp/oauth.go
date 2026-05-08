package mcp

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"crypto/tls"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ctxKey is a context key type for user info
type ctxKey string

const (
	UserSubjectCtxKey ctxKey = "user_subject"

	// APITokenPrefix marks long-lived static API tokens. Bearer values that
	// begin with this prefix are looked up in the api_tokens table instead of
	// being parsed as JWTs.
	APITokenPrefix = "mcp_"
)

// APITokenStore is the subset of the store needed by the OAuth middleware to
// support long-lived API tokens. Both *store.Store and test fakes implement it.
type APITokenStore interface {
	FindAPITokenByHash(ctx context.Context, hash string) (*store.APIToken, error)
	TouchAPITokenLastUsed(ctx context.Context, id int64) error
}

// OAuthHandler handles OAuth-related endpoints and token validation
type OAuthHandler struct {
	config     *Config
	jwksCache  *JWKSCache
	httpClient *http.Client
	tokens     APITokenStore

	// Replay protection
	seenJTIs   map[string]time.Time
	jtiMutex   sync.RWMutex
	cleanupCtx context.Context
	cleanupCancel context.CancelFunc
}

// JWKSCache caches JWKS (JSON Web Key Set) for token validation
type JWKSCache struct {
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastUpdate time.Time
	ttl        time.Duration
}

// NewOAuthHandler creates a new OAuth handler. The tokens argument may be nil
// — when nil, the API-token bypass is disabled and only JWT auth works.
func NewOAuthHandler(cfg *Config, tokens APITokenStore) *OAuthHandler {
	ctx, cancel := context.WithCancel(context.Background())
	h := &OAuthHandler{
		config: cfg,
		jwksCache: &JWKSCache{
			keys: make(map[string]*rsa.PublicKey),
			ttl:  1 * time.Hour,
		},
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{
					Timeout:   5 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				ForceAttemptHTTP2:     true,
				MaxIdleConns:          100,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   5 * time.Second,
				ExpectContinueTimeout: 1 * time.Second,
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
				},
			},
		},
		tokens:        tokens,
		seenJTIs:      make(map[string]time.Time),
		cleanupCtx:    ctx,
		cleanupCancel: cancel,
	}

	// Start background cleanup for JTIs
	go h.startJTICleanup()
	return h
}

// Close stops background routines
func (h *OAuthHandler) Close() {
	if h.cleanupCancel != nil {
		h.cleanupCancel()
	}
}

// startJTICleanup runs periodically to remove expired JTIs from the cache
func (h *OAuthHandler) startJTICleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.cleanupCtx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			h.jtiMutex.Lock()
			for jti, expiry := range h.seenJTIs {
				if now.After(expiry) {
					delete(h.seenJTIs, jti)
				}
			}
			h.jtiMutex.Unlock()
		}
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
	if err := json.NewEncoder(w).Encode(metadata); err != nil {
		slog.Error("encode response", "error", err)
	}
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

		// API token bypass: a Bearer value with the mcp_ prefix is looked up
		// in the api_tokens table rather than parsed as a JWT.
		if strings.HasPrefix(tokenString, APITokenPrefix) {
			if h.tokens == nil {
				slog.Warn("[MCP/OAuth] API token presented but token store is not configured")
				h.sendUnauthorized(w, "invalid token")
				return
			}
			sum := sha256.Sum256([]byte(tokenString))
			hash := hex.EncodeToString(sum[:])
			tok, err := h.tokens.FindAPITokenByHash(r.Context(), hash)
			if err != nil {
				slog.Error("[MCP/OAuth] API token lookup failed", "error", err)
				h.sendUnauthorized(w, "invalid token")
				return
			}
			if tok == nil {
				slog.Warn("[MCP/OAuth] API token not recognized")
				h.sendUnauthorized(w, "invalid token")
				return
			}
			if err := h.tokens.TouchAPITokenLastUsed(r.Context(), tok.ID); err != nil {
				slog.Warn("[MCP/OAuth] Failed to touch API token last_used_at", "error", err, "token_id", tok.ID)
			}
			subject := "api-token:" + tok.Name
			slog.Info("[MCP/OAuth] API token authorized", "token_name", tok.Name)
			ctx := context.WithValue(r.Context(), UserSubjectCtxKey, subject)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// Validate the token
		subject, err := h.validateToken(r.Context(), tokenString)
		if err != nil {
			slog.Warn("[MCP/OAuth] Token validation failed", "error", err)
			h.sendUnauthorized(w, "invalid token")
			return
		}

		// Check if the subject matches the allowed subject(s)
		if !h.isSubjectAllowed(subject) {
			slog.Warn("[MCP/OAuth] Subject not allowed", "subject", subject, "expected", h.config.AllowedSubject) // #nosec G706
			h.sendForbidden(w, "user not authorized")
			return
		}

		slog.Info("[MCP/OAuth] Authorized request", "subject", subject) // #nosec G706

		// Add subject to context
		ctx := context.WithValue(r.Context(), UserSubjectCtxKey, subject)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *OAuthHandler) isSubjectAllowed(subject string) bool {
	raw := strings.TrimSpace(h.config.AllowedSubject)
	if raw == "" {
		return false
	}

	for _, candidate := range strings.Split(raw, ",") {
		if strings.TrimSpace(candidate) == subject {
			return true
		}
	}

	return false
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
	// Ensure issuer matches exactly as configured in PocketIDURL
	issuer := strings.TrimSuffix(h.config.PocketIDURL, "/")
	validToken, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		// Verify signing method is RSA
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return publicKey, nil
	}, jwt.WithExpirationRequired(), jwt.WithIssuer(issuer))
	if err != nil {
		// Debug logging for claims comparison
		if claims, ok := token.Claims.(jwt.MapClaims); ok {
			slog.Debug("[MCP/OAuth] Configured Audience", "expected_aud", h.config.MCPServerURL)
			if aud, ok := claims["aud"]; ok {
				slog.Debug("[MCP/OAuth] Token Audience", "aud", aud)
			} else {
				slog.Debug("[MCP/OAuth] Token Audience (aud) claim missing")
			}
			if sub, ok := claims["sub"]; ok {
				slog.Debug("[MCP/OAuth] Token Subject", "sub", sub)
			}
		}
		return "", fmt.Errorf("token validation failed: %w", err)
	}

	claims, ok := validToken.Claims.(jwt.MapClaims)
	if !ok {
		return "", fmt.Errorf("invalid claims type")
	}

	// Manual Audience Validation
	// We allow audience to be either the MCP Server URL OR one of configured Client IDs.
	// (Pocket-ID often uses Client ID as audience for access tokens)
	audClaim, err := validToken.Claims.GetAudience()
	if err != nil {
		return "", fmt.Errorf("invalid audience claim: %w", err)
	}

	validAudience := false
	for _, aud := range audClaim {
		if h.isAudienceAllowed(aud) {
			validAudience = true
			break
		}
	}

	if !validAudience {
		// Log actual audiences for debugging
		slog.Warn("[MCP/OAuth] Audience Validation Failed",
			"expected_mcp", h.config.MCPServerURL,
			"expected_client", h.config.ClientID,
			"got", audClaim)
		return "", fmt.Errorf("token audience mismatch")
	}

	// Check for Replay Attack if JTI is present
	if jtiClaim, ok := claims["jti"].(string); ok && jtiClaim != "" {
		h.jtiMutex.Lock()
		if _, seen := h.seenJTIs[jtiClaim]; seen {
			h.jtiMutex.Unlock()
			slog.Warn("[MCP/OAuth] Replay detected: Token JTI already used", "jti", jtiClaim)
			return "", fmt.Errorf("token replay detected")
		}

		// Calculate expiry based on exp claim
		var expiryTime time.Time
		if expClaim, ok := claims["exp"].(float64); ok {
			expiryTime = time.Unix(int64(expClaim), 0)
		} else {
			// If we can't get expiration, we must keep JTI indefinitely to be secure
			// Though valid tokens should have exp as we enforce WithExpirationRequired
			expiryTime = time.Now().AddDate(100, 0, 0) // very long time
		}

		h.seenJTIs[jtiClaim] = expiryTime
		h.jtiMutex.Unlock()
	}

	subject, ok := claims["sub"].(string)
	if !ok {
		return "", fmt.Errorf("missing sub claim")
	}

	return subject, nil
}

func (h *OAuthHandler) isAudienceAllowed(aud string) bool {
	if aud == h.config.MCPServerURL {
		return true
	}

	for _, clientID := range strings.Split(strings.TrimSpace(h.config.ClientID), ",") {
		if strings.TrimSpace(clientID) == aud {
			return true
		}
	}

	return false
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

	parsedURL, err := url.Parse(jwksURL)
	if err != nil {
		return fmt.Errorf("invalid JWKS URL: %w", err)
	}

	if parsedURL.Scheme != "https" {
		isLocal := parsedURL.Hostname() == "localhost" || parsedURL.Hostname() == "127.0.0.1"
		if !isLocal {
			return fmt.Errorf("HTTPS is required for JWKS endpoint (got %s)", parsedURL.Scheme)
		}
	}

	fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Try to fetch from URL
	req, err := http.NewRequestWithContext(fetchCtx, "GET", jwksURL, nil)
	var jwksData []byte

	if err == nil {
		resp, err := h.httpClient.Do(req) // #nosec G107
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				jwksData, _ = io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
			} else {
				slog.Warn("[MCP/OAuth] JWKS fetch returned unexpected status", "status", resp.StatusCode)
			}
		} else {
			slog.Warn("[MCP/OAuth] JWKS fetch failed", "error", err)
		}
	}

	// Fallback to static JSON if fetch failed
	if len(jwksData) == 0 {
		if h.config.JWKSJSON != "" {
			slog.Info("[MCP/OAuth] Using static JWKS fallback")
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
			slog.Warn("[MCP/OAuth] Failed to parse key", "kid", jwk.Kid, "error", err)
			continue
		}

		h.jwksCache.keys[jwk.Kid] = publicKey
	}

	h.jwksCache.lastUpdate = time.Now()
	slog.Info("[MCP/OAuth] Refreshed JWKS", "cached_keys", len(h.jwksCache.keys))

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
