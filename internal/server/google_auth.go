package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// OIDC Configuration
type OIDCConfig struct {
	Provider       string
	ClientID       string
	ClientSecret   string // #nosec G117 -- OAuth client secret, held in memory from env var
	RedirectURL    string
	AdminEmail     string
	AllowedSubject string
	IssuerURL      string
	AuthURL        string
	TokenURL       string
	UserInfoURL    string
	ButtonLabel    string
	ButtonColor    string
	ButtonText     string
	Scopes         []string
}

// Initialize OAuth2 config
func (s *Server) initOAUTH() {
	if s.oidcConfig.ClientID == "" {
		return
	}

	scopes := s.oidcConfig.Scopes
	if len(scopes) == 0 {
		scopes = []string{"openid", "email", "profile"}
	}

	endpoint, userInfoURL, err := resolveOIDCEndpoints(s.oidcConfig)
	if err != nil {
		slog.Error("Failed to resolve OIDC endpoints", "error", err)
		return
	}

	s.oauthConfig = &oauth2.Config{
		ClientID:     s.oidcConfig.ClientID,
		ClientSecret: s.oidcConfig.ClientSecret,
		RedirectURL:  s.oidcConfig.RedirectURL,
		Scopes:       scopes,
		Endpoint:     endpoint,
	}
	s.oidcUserInfo = userInfoURL
}

// Generate random state
func generateStateOauthCookie(w http.ResponseWriter) (string, error) {
	var expiration = time.Now().Add(20 * time.Minute)

	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	state := base64.URLEncoding.EncodeToString(b)
	cookie := http.Cookie{
		Name:     "oauthstate",
		Value:    state,
		Expires:  expiration,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
	}
	http.SetCookie(w, &cookie)

	return state, nil
}

// Handler: Start Login
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "OIDC not configured", http.StatusInternalServerError)
		return
	}
	oauthState, err := generateStateOauthCookie(w)
	if err != nil {
		http.Error(w, "failed to generate oauth state", http.StatusInternalServerError)
		return
	}
	u := s.oauthConfig.AuthCodeURL(oauthState)
	http.Redirect(w, r, u, http.StatusTemporaryRedirect)
}

// Handler: Callback
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "OIDC not configured", http.StatusInternalServerError)
		return
	}

	// Limit request body size to 1MB to prevent memory exhaustion when parsing form data
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	// Verify State
	oauthState, err := r.Cookie("oauthstate")
	if err != nil || oauthState == nil {
		http.Error(w, "missing oauth state", http.StatusBadRequest)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.FormValue("state")), []byte(oauthState.Value)) != 1 {
		http.Error(w, "invalid oauth state", http.StatusUnauthorized)
		return
	}

	// Exchange Code for Token
	code := r.FormValue("code")
	token, err := s.oauthConfig.Exchange(context.Background(), code)
	if err != nil {
		http.Error(w, "code exchange failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if s.oidcUserInfo == "" {
		http.Error(w, "OIDC userinfo endpoint not configured", http.StatusInternalServerError)
		return
	}

	// Get User Info
	req, err := http.NewRequest(http.MethodGet, s.oidcUserInfo, nil) // #nosec G107
	if err != nil {
		http.Error(w, "failed creating userinfo request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req) // #nosec G107
	if err != nil {
		http.Error(w, "failed getting user info: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		http.Error(w, "failed getting user info: provider returned "+resp.Status, http.StatusInternalServerError)
		return
	}

	var userInfo struct {
		Email             string `json:"email"`
		EmailVerified     bool   `json:"email_verified"`
		Sub               string `json:"sub"`
		ID                string `json:"id"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&userInfo); err != nil {
		http.Error(w, "failed decoding user info", http.StatusInternalServerError)
		return
	}

	subject := userInfo.Sub
	if subject == "" {
		subject = userInfo.ID
	}

	// Authorize
	// If both AdminEmail and AllowedSubject are empty, trust the OIDC provider (allow all authenticated users)
	if s.oidcConfig.AllowedSubject == "" && s.oidcConfig.AdminEmail == "" {
		// Allow all authenticated users from this OIDC provider
		slog.Info("Allowing authenticated user (allow-all mode)", "user", firstNonEmpty(userInfo.Email, subject, userInfo.PreferredUsername))
	} else {
		// Strict mode: check subject and/or email
		if s.oidcConfig.AllowedSubject != "" {
			if subject == "" || subject != s.oidcConfig.AllowedSubject {
				http.Error(w, "Forbidden: access denied", http.StatusForbidden)
				return
			}
		}
		if s.oidcConfig.AdminEmail != "" {
			if userInfo.Email == "" || userInfo.Email != s.oidcConfig.AdminEmail {
				http.Error(w, "Forbidden: access denied", http.StatusForbidden)
				return
			}
		}
	}

	// Create Session (Simple implementation)
	// In a real app we might want a session store, but for single user bot, we can use a signed cookie or just a simple secret cookie
	// For simplicity, we'll set a secure httponly cookie with a value we can verify.
	// We'll trust this cookie in auth middleware.

	// Just use the email as session value, signed with bot token to prevent tampering
	sessionValue := createSessionToken(firstNonEmpty(userInfo.Email, subject, userInfo.PreferredUsername), s.sessionSecret)
	http.SetCookie(w, &http.Cookie{
		Name:     "auth_session",
		Value:    sessionValue,
		Expires:  time.Now().Add(24 * time.Hour * 30), // 30 days
		HttpOnly: true,
		Secure:   true,                 // Only send over HTTPS
		SameSite: http.SameSiteLaxMode, // CSRF protection
		Path:     "/",
	})

	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}

func resolveOIDCEndpoints(cfg OIDCConfig) (oauth2.Endpoint, string, error) {
	if cfg.Provider == "google" {
		userInfo := cfg.UserInfoURL
		if userInfo == "" {
			userInfo = "https://www.googleapis.com/oauth2/v2/userinfo"
		}
		return google.Endpoint, userInfo, nil
	}

	// If explicit endpoints are set, use them.
	if cfg.AuthURL != "" && cfg.TokenURL != "" {
		userInfo := cfg.UserInfoURL
		if userInfo == "" {
			return oauth2.Endpoint{}, "", errors.New("OIDC_USERINFO_URL is required when using explicit auth/token URLs")
		}
		return oauth2.Endpoint{AuthURL: cfg.AuthURL, TokenURL: cfg.TokenURL}, userInfo, nil
	}

	if cfg.IssuerURL == "" {
		return oauth2.Endpoint{}, "", errors.New("OIDC_ISSUER_URL is required")
	}
	// Allow HTTP for localhost and internal container URLs, require HTTPS for external URLs
	if strings.HasPrefix(cfg.IssuerURL, "http://") {
		if !strings.Contains(cfg.IssuerURL, "localhost") && !strings.Contains(cfg.IssuerURL, "127.0.0.1") && !strings.Contains(cfg.IssuerURL, ":") {
			return oauth2.Endpoint{}, "", errors.New("OIDC_ISSUER_URL must use https for external URLs")
		}
	}

	discoveryURL := strings.TrimSuffix(cfg.IssuerURL, "/") + "/.well-known/openid-configuration"
	req, err := http.NewRequest(http.MethodGet, discoveryURL, nil)
	if err != nil {
		return oauth2.Endpoint{}, "", err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return oauth2.Endpoint{}, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return oauth2.Endpoint{}, "", fmt.Errorf("discovery returned status %d", resp.StatusCode)
	}

	var discovery struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserInfoEndpoint      string `json:"userinfo_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&discovery); err != nil {
		return oauth2.Endpoint{}, "", err
	}
	if discovery.AuthorizationEndpoint == "" || discovery.TokenEndpoint == "" {
		return oauth2.Endpoint{}, "", errors.New("discovery response missing auth or token endpoint")
	}
	if discovery.UserInfoEndpoint == "" {
		return oauth2.Endpoint{}, "", errors.New("discovery response missing userinfo endpoint")
	}
	return oauth2.Endpoint{
		AuthURL:  discovery.AuthorizationEndpoint,
		TokenURL: discovery.TokenEndpoint,
	}, discovery.UserInfoEndpoint, nil
}

func defaultOIDCButtonLabel(cfg OIDCConfig) string {
	if cfg.ButtonLabel != "" {
		return cfg.ButtonLabel
	}
	if cfg.Provider == "google" {
		return "Login with Google"
	}
	issuer := strings.ToLower(cfg.IssuerURL)
	if strings.Contains(issuer, "pocket") {
		return "Login with Pocket-ID"
	}
	return "Login"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return "oidc-user"
}

func createSessionToken(email, secret string) string {
	// Stateless session rotation: payload is base64url_nopad(email|nonce|timestamp) + "." + hex(hmac(payload, secret))
	nonce := make([]byte, 12)
	rand.Read(nonce)
	timestamp := time.Now().Unix()
	payload := fmt.Sprintf("%s|%s|%d", email, hex.EncodeToString(nonce), timestamp)

	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	sig := hex.EncodeToString(h.Sum(nil))

	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

func verifySessionToken(token, secret string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		// Fallback: try the old format with URLEncoding padding
		// (handles cookies set by a previous version of the server)
		if len(parts) > 2 {
			// More than one dot: rejoin all but last as base64 part
			paddedEmail := strings.Join(parts[:len(parts)-1], ".")
			sig := parts[len(parts)-1]
			emailBytes, err := base64.URLEncoding.DecodeString(paddedEmail)
			if err == nil {
				email := string(emailBytes)
				h := hmac.New(sha256.New, []byte(secret))
				h.Write([]byte(email))
				expectedSig, err := hex.DecodeString(sig)
				if err == nil && hmac.Equal(h.Sum(nil), expectedSig) {
					return email, true
				}
			}
		}
		return "", false
	}

	// Base64 decode payload
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		// Try old padded format as fallback
		payloadBytes, err = base64.URLEncoding.DecodeString(parts[0])
		if err != nil {
			return "", false
		}
	}
	payload := string(payloadBytes)

	// Validate signature using full payload
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	calculatedSig := h.Sum(nil)

	expectedSig, err := hex.DecodeString(parts[1])
	if err != nil {
		return "", false
	}

	if !hmac.Equal(calculatedSig, expectedSig) {
		return "", false
	}

	// Try new payload format first: email|nonce|timestamp
	payloadParts := strings.Split(payload, "|")
	if len(payloadParts) == 3 {
		// Validate timestamp
		var timestamp int64
		_, err := fmt.Sscanf(payloadParts[2], "%d", &timestamp)
		if err == nil {
			// Session is invalid if older than 30 days
			if time.Now().Unix() - timestamp > 30*24*60*60 {
				return "", false
			}
			return payloadParts[0], true
		}
	}

	// Fallback to old format (payload is just email)
	return payload, true
}
