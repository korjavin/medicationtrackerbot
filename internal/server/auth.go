package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

func AuthMiddleware(botToken string, allowedUserID int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check Authorization header or query param
			// Telegram usually sends it in InitData

			// For simplicity, we'll expect a header "X-Telegram-Init-Data" or query "initData"
			initData := r.Header.Get("X-Telegram-Init-Data")
			if initData == "" {
				initData = r.URL.Query().Get("initData")
			}

			if initData == "" {
				http.Error(w, "Unauthorized: No init data", http.StatusUnauthorized)
				return
			}

			valid, user, err := ValidateWebAppData(botToken, initData)
			if !valid || err != nil {
				http.Error(w, "Unauthorized: Invalid hash", http.StatusForbidden)
				return
			}

			if user.ID != allowedUserID {
				http.Error(w, "Forbidden: User not allowed", http.StatusForbidden)
				return
			}

			ctx := context.WithValue(r.Context(), UserCtxKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
