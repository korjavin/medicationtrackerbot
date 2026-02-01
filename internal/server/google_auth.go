package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// OIDC Configuration
type OIDCConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
	AdminEmail   string
}

// Initialize OAuth2 config
func (s *Server) initOAUTH() {
	if s.oidcConfig.ClientID == "" {
		return
	}
	s.oauthConfig = &oauth2.Config{
		ClientID:     s.oidcConfig.ClientID,
		ClientSecret: s.oidcConfig.ClientSecret,
		RedirectURL:  s.oidcConfig.RedirectURL,
		Scopes: []string{
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		},
		Endpoint: google.Endpoint,
	}
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
func (s *Server) handleGoogleLogin(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "Google Auth not configured", http.StatusInternalServerError)
		return
	}
	oauthState := generateStateOauthCookie(w)
	u := s.oauthConfig.AuthCodeURL(oauthState)
	http.Redirect(w, r, u, http.StatusTemporaryRedirect)
}

// Handler: Callback
func (s *Server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	if s.oauthConfig == nil {
		http.Error(w, "Google Auth not configured", http.StatusInternalServerError)
		return
	}

	// Verify State
	oauthState, _ := r.Cookie("oauthstate")
	if r.FormValue("state") != oauthState.Value {
		http.Error(w, "invalid oauth google state", http.StatusUnauthorized)
		return
	}

	// Exchange Code for Token
	code := r.FormValue("code")
	token, err := s.oauthConfig.Exchange(context.Background(), code)
	if err != nil {
		http.Error(w, "code exchange failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Get User Info
	resp, err := http.Get("https://www.googleapis.com/oauth2/v2/userinfo?access_token=" + token.AccessToken)
	if err != nil {
		http.Error(w, "failed getting user info: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	var userInfo struct {
		Email string `json:"email"`
		ID    string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&userInfo); err != nil {
		http.Error(w, "failed decoding user info", http.StatusInternalServerError)
		return
	}

	// Authorize Email
	if userInfo.Email != s.oidcConfig.AdminEmail {
		http.Error(w, fmt.Sprintf("Forbidden: %s is not authorized", userInfo.Email), http.StatusForbidden)
		return
	}

	// Create Session (Simple implementation)
	// In a real app we might want a session store, but for single user bot, we can use a signed cookie or just a simple secret cookie
	// For simplicity, we'll set a secure httponly cookie with a value we can verify.
	// We'll trust this cookie in auth middleware.

	// Just use the email as session value, signed with bot token to prevent tampering
	sessionValue := createSessionToken(userInfo.Email, s.botToken)
	http.SetCookie(w, &http.Cookie{
		Name:     "auth_session",
		Value:    sessionValue,
		Expires:  time.Now().Add(24 * time.Hour * 30), // 30 days
		HttpOnly: true,
		Secure:   true,                    // Only send over HTTPS
		SameSite: http.SameSiteLaxMode,    // CSRF protection
		Path:     "/",
	})

	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
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
