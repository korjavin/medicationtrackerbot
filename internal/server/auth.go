package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/server/auth"
)

type ctxKey string

const (
	UserCtxKey ctxKey = "user"
)

// TelegramUser is the user identity carried in request context after
// authentication. It is an alias for auth.User so the resolver package can
// produce values handlers read back via (*TelegramUser).ID without any conversion.
type TelegramUser = auth.User

func getUserID(r *http.Request) (int64, error) {
	user, ok := r.Context().Value(UserCtxKey).(*TelegramUser)
	if !ok || user == nil {
		return 0, fmt.Errorf("unauthorized")
	}
	return user.ID, nil
}

func ValidateWebAppData(token, initData string) (bool, *TelegramUser, error) {
	if initData == "" {
		return false, nil, fmt.Errorf("empty init data")
	}

	parsed, err := url.ParseQuery(initData)
	if err != nil {
		return false, nil, err
	}

	hash := parsed.Get("hash")
	if hash == "" {
		return false, nil, fmt.Errorf("missing hash")
	}

	// Remove hash from map to build data check string
	parsed.Del("hash")

	var keys []string
	for k := range parsed {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var dataCheckArr []string
	for _, k := range keys {
		dataCheckArr = append(dataCheckArr, fmt.Sprintf("%s=%s", k, parsed.Get(k)))
	}
	dataCheckString := strings.Join(dataCheckArr, "\n")

	// HMAC-SHA256 signature
	secretKey := hmac.New(sha256.New, []byte("WebAppData"))
	secretKey.Write([]byte(token))
	secret := secretKey.Sum(nil)

	h := hmac.New(sha256.New, secret)
	h.Write([]byte(dataCheckString))
	calculatedHash := h.Sum(nil)

	expectedHash, err := hex.DecodeString(hash)
	if err != nil {
		return false, nil, fmt.Errorf("invalid hash hex")
	}

	if !hmac.Equal(calculatedHash, expectedHash) {
		return false, nil, fmt.Errorf("hash mismatch")
	}

	// Check auth_date
	authDateStr := parsed.Get("auth_date")
	if authDateStr == "" {
		return false, nil, fmt.Errorf("auth_date missing")
	}

	authDate, err := strconv.ParseInt(authDateStr, 10, 64)
	if err != nil {
		return false, nil, fmt.Errorf("invalid auth_date")
	}

	webAppDiff := time.Now().Unix() - authDate
	if webAppDiff > 86400 { // 24 hours
		return false, nil, fmt.Errorf("auth_date expired")
	}
	if webAppDiff < -60 { // allow 60s clock skew
		return false, nil, fmt.Errorf("auth_date is in the future")
	}

	// Parse user data
	userJSON := parsed.Get("user")
	var user TelegramUser
	if err := json.Unmarshal([]byte(userJSON), &user); err != nil {
		return true, nil, err // Valid hash but invalid json?
	}

	return true, &user, nil
}

// TelegramLoginData represents data from Telegram Login Widget callback
type TelegramLoginData struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Username  string `json:"username,omitempty"`
	PhotoURL  string `json:"photo_url,omitempty"`
	AuthDate  int64  `json:"auth_date"`
	Hash      string `json:"hash"`
}

// ValidateTelegramLoginWidget validates data from Telegram Login Widget
// Uses SHA256(bot_token) as secret key (different from WebApp validation)
func ValidateTelegramLoginWidget(token string, data TelegramLoginData) (bool, *TelegramUser, error) {
	// Build data-check-string: sorted fields joined with \n (excluding hash)
	var parts []string

	parts = append(parts, fmt.Sprintf("auth_date=%d", data.AuthDate))
	if data.FirstName != "" {
		parts = append(parts, fmt.Sprintf("first_name=%s", data.FirstName))
	}
	parts = append(parts, fmt.Sprintf("id=%d", data.ID))
	if data.LastName != "" {
		parts = append(parts, fmt.Sprintf("last_name=%s", data.LastName))
	}
	if data.PhotoURL != "" {
		parts = append(parts, fmt.Sprintf("photo_url=%s", data.PhotoURL))
	}
	if data.Username != "" {
		parts = append(parts, fmt.Sprintf("username=%s", data.Username))
	}

	sort.Strings(parts)
	dataCheckString := strings.Join(parts, "\n")

	// Secret key = SHA256(bot_token)
	secretHash := sha256.Sum256([]byte(token))

	// HMAC-SHA256(data_check_string, secret_key)
	h := hmac.New(sha256.New, secretHash[:])
	h.Write([]byte(dataCheckString))
	calculatedHash := h.Sum(nil)

	expectedHash, err := hex.DecodeString(data.Hash)
	if err != nil {
		return false, nil, fmt.Errorf("invalid hash hex")
	}

	if !hmac.Equal(calculatedHash, expectedHash) {
		return false, nil, fmt.Errorf("hash mismatch")
	}

	// Check auth_date is within valid range (not expired and not in the future)
	diff := time.Now().Unix() - data.AuthDate
	if diff > 86400 {
		return false, nil, fmt.Errorf("auth_date expired")
	}
	if diff < -60 { // allow 60s clock skew
		return false, nil, fmt.Errorf("auth_date is in the future")
	}

	user := &TelegramUser{
		ID:        data.ID,
		FirstName: data.FirstName,
		LastName:  data.LastName,
		Username:  data.Username,
	}

	return true, user, nil
}

// AuthMiddleware delegates user identification to the supplied UserResolver and
// maps its sentinel errors to HTTP responses. The resolver is the only place
// auth credentials are interpreted; the middleware just enforces the result.
func AuthMiddleware(resolver auth.UserResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := resolver.Resolve(r)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrNoAuth):
					http.Error(w, "Unauthorized: No init data", http.StatusUnauthorized)
				case errors.Is(err, auth.ErrUserNotAllowed):
					http.Error(w, "Forbidden: User not allowed", http.StatusForbidden)
				default:
					http.Error(w, "Unauthorized: Invalid hash", http.StatusForbidden)
				}
				return
			}

			ctx := context.WithValue(r.Context(), UserCtxKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	response := struct {
		Authenticated bool   `json:"authenticated"`
		Method        string `json:"method,omitempty"`
	}{
		Authenticated: false,
	}

	if cookie, err := r.Cookie("auth_session"); err == nil {
		if _, ok := verifySessionToken(cookie.Value, s.sessionSecret); ok {
			response.Authenticated = true
			response.Method = "cookie"
		}
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}
