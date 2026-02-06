package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type ctxKey string

const (
	UserCtxKey ctxKey = "user"
)

type TelegramUser struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
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
	calculatedHash := hex.EncodeToString(h.Sum(nil))

	if calculatedHash != hash {
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

	if time.Now().Unix()-authDate > 86400 { // 24 hours
		return false, nil, fmt.Errorf("auth_date expired")
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
	calculatedHash := hex.EncodeToString(h.Sum(nil))

	if calculatedHash != data.Hash {
		return false, nil, fmt.Errorf("hash mismatch")
	}

	// Check auth_date is not expired (24 hours)
	if time.Now().Unix()-data.AuthDate > 86400 {
		return false, nil, fmt.Errorf("auth_date expired")
	}

	user := &TelegramUser{
		ID:        data.ID,
		FirstName: data.FirstName,
		LastName:  data.LastName,
		Username:  data.Username,
	}

	return true, user, nil
}

func AuthMiddleware(botToken string, allowedUserID int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {

			// 1. Check for OIDC Session Cookie
			cookie, err := r.Cookie("auth_session")
			if err == nil {
				if email, ok := verifySessionToken(cookie.Value, botToken); ok {
					// Create a dummy user from session
					user := &TelegramUser{
						ID:        allowedUserID, // Map admin email to allowed user ID for DB consistency
						FirstName: "Admin",
						LastName:  "(OIDC)",
						Username:  email,
					}
					ctx := context.WithValue(r.Context(), UserCtxKey, user)
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
				log.Printf("[AUTH] Invalid session cookie from %s", r.RemoteAddr)
			}

			// 2. Check for Telegram InitData (Authorization header or query param)
			initData := r.Header.Get("X-Telegram-Init-Data")
			if initData == "" {
				initData = r.URL.Query().Get("initData")
			}

			if initData == "" {
				log.Printf("[AUTH] No auth data from %s for %s %s", r.RemoteAddr, r.Method, r.URL.Path)
				http.Error(w, "Unauthorized: No init data", http.StatusUnauthorized)
				return
			}

			valid, user, err := ValidateWebAppData(botToken, initData)
			if !valid || err != nil {
				log.Printf("[AUTH] Invalid WebApp hash from %s: %v", r.RemoteAddr, err)
				http.Error(w, "Unauthorized: Invalid hash", http.StatusForbidden)
				return
			}

			if user.ID != allowedUserID {
				log.Printf("[AUTH] Unauthorized user ID %d (username: %s) from %s", user.ID, user.Username, r.RemoteAddr)
				http.Error(w, "Forbidden: User not allowed", http.StatusForbidden)
				return
			}

			ctx := context.WithValue(r.Context(), UserCtxKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
