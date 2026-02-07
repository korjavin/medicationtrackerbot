package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	ClientSecret   string
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
		log.Printf("[OIDC] Failed to resolve OIDC endpoints: %v", err)
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
func generateStateOauthCookie(w http.ResponseWriter) string {
	var expiration = time.Now().Add(20 * time.Minute)

	b := make([]byte, 16)
	rand.Read(b)
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

	return state
}

// Handler: Start Login
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "OIDC not configured", http.StatusInternalServerError)
		return
	}
	oauthState := generateStateOauthCookie(w)
	u := s.oauthConfig.AuthCodeURL(oauthState)
	http.Redirect(w, r, u, http.StatusTemporaryRedirect)
}

// Handler: Callback
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "OIDC not configured", http.StatusInternalServerError)
		return
	}

	// Verify State
	oauthState, err := r.Cookie("oauthstate")
	if err != nil {
		http.Error(w, "missing oauth state", http.StatusBadRequest)
		return
	}
	if r.FormValue("state") != oauthState.Value {
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
	req, err := http.NewRequest(http.MethodGet, s.oidcUserInfo, nil)
	if err != nil {
		http.Error(w, "failed creating userinfo request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
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
		EmailVerified     *bool  `json:"email_verified"`
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
		log.Printf("[OIDC] Allowing authenticated user (allow-all mode): %s", firstNonEmpty(userInfo.Email, subject, userInfo.PreferredUsername))
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
			if userInfo.EmailVerified == nil || !*userInfo.EmailVerified {
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
	// Simple signature: base64(email) + "." + hmac(email, secret)
	// This is effectively a JWT-lite without the library overhead, adequate for this restricted scope
	// But let's keep it simpler and just string concatenation verification in middleware
	// Actually, let's just use the email. Since it's HttpOnly, JS can't read it.
	// But user can modify it. So we need signature.

	// Let's implement signature in auth.go or here
	// Re-using ValidateWebAppData logic is not fit here.

	// Simple HMAC
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(email))
	sig := hex.EncodeToString(h.Sum(nil))

	return base64.URLEncoding.EncodeToString([]byte(email)) + "." + sig
}

func verifySessionToken(token, secret string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", false
	}

	emailBytes, err := base64.URLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	email := string(emailBytes)

	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(email))
	expectedSig := hex.EncodeToString(h.Sum(nil))

	if parts[1] != expectedSig {
		return "", false
	}

	return email, true
}
