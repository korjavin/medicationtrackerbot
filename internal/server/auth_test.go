package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/server/auth"
)

// fakeResolver is a controllable auth.UserResolver implementation for
// AuthMiddleware tests. Set User to a non-nil value to simulate a resolved
// user, or set Err to one of the auth.Err* sentinels to simulate a failure.
type fakeResolver struct {
	User *auth.User
	Err  error
}

func (f *fakeResolver) Resolve(r *http.Request) (*auth.User, error) {
	if f.Err != nil {
		return nil, f.Err
	}
	return f.User, nil
}

func TestAuthMiddleware_ResolverSuccess(t *testing.T) {
	resolver := &fakeResolver{User: &auth.User{ID: 42, FirstName: "Test"}}
	mw := AuthMiddleware(resolver)

	var seen *TelegramUser
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, ok := r.Context().Value(UserCtxKey).(*TelegramUser); ok {
			seen = u
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if seen == nil || seen.ID != 42 {
		t.Fatalf("expected user in ctx with ID=42, got %+v", seen)
	}
}

func TestAuthMiddleware_ResolverErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "no auth → 401", err: auth.ErrNoAuth, want: http.StatusUnauthorized},
		{name: "invalid auth → 403", err: auth.ErrInvalidAuth, want: http.StatusForbidden},
		{name: "user not allowed → 403", err: auth.ErrUserNotAllowed, want: http.StatusForbidden},
		{name: "unknown error → 403", err: fmt.Errorf("boom"), want: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mw := AuthMiddleware(&fakeResolver{Err: tt.err})
			called := false
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if called {
				t.Error("expected inner handler NOT to be called when resolver returns error")
			}
			if w.Code != tt.want {
				t.Errorf("expected %d, got %d", tt.want, w.Code)
			}
		})
	}
}

// mockNonceStore implements NonceStore for tests using an in-memory map.
type mockNonceStore struct {
	used map[string]bool
}

func newMockNonceStore() *mockNonceStore {
	return &mockNonceStore{used: make(map[string]bool)}
}

func (m *mockNonceStore) TryUseLoginHash(hash string, _ time.Time) (bool, error) {
	if m.used[hash] {
		return false, nil
	}
	m.used[hash] = true
	return true, nil
}

// Helper to build valid WebApp initData with correct HMAC signature.
func buildWebAppInitData(token string, authDate int64, userJSON string) string {
	params := url.Values{}
	params.Set("auth_date", fmt.Sprintf("%d", authDate))
	params.Set("user", userJSON)

	keys := []string{"auth_date", "user"}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, k+"="+params.Get(k))
	}
	dataCheckString := strings.Join(parts, "\n")

	secretKey := hmac.New(sha256.New, []byte("WebAppData"))
	secretKey.Write([]byte(token))
	secret := secretKey.Sum(nil)

	h := hmac.New(sha256.New, secret)
	h.Write([]byte(dataCheckString))
	hash := hex.EncodeToString(h.Sum(nil))

	params.Set("hash", hash)
	return params.Encode()
}

// Helper to build valid TelegramLoginData with correct HMAC signature.
func buildLoginData(token string, data TelegramLoginData) TelegramLoginData {
	var parts []string
	parts = append(parts, fmt.Sprintf("auth_date=%d", data.AuthDate))
	if data.FirstName != "" {
		parts = append(parts, "first_name="+data.FirstName)
	}
	parts = append(parts, fmt.Sprintf("id=%d", data.ID))
	if data.LastName != "" {
		parts = append(parts, "last_name="+data.LastName)
	}
	if data.PhotoURL != "" {
		parts = append(parts, "photo_url="+data.PhotoURL)
	}
	if data.Username != "" {
		parts = append(parts, "username="+data.Username)
	}
	sort.Strings(parts)
	dataCheckString := strings.Join(parts, "\n")

	secretHash := sha256.Sum256([]byte(token))
	h := hmac.New(sha256.New, secretHash[:])
	h.Write([]byte(dataCheckString))
	data.Hash = hex.EncodeToString(h.Sum(nil))
	return data
}

func TestValidateWebAppData_ValidSignature(t *testing.T) {
	token := "test-bot-token" // #nosec G101
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	initData := buildWebAppInitData(token, time.Now().Unix(), userJSON)

	valid, user, err := ValidateWebAppData(token, initData)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatal("expected valid signature")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.ID != 123456 {
		t.Errorf("expected user ID 123456, got %d", user.ID)
	}
	if user.FirstName != "Test" {
		t.Errorf("expected first name 'Test', got %q", user.FirstName)
	}
	if user.LastName != "User" {
		t.Errorf("expected last name 'User', got %q", user.LastName)
	}
	if user.Username != "testuser" {
		t.Errorf("expected username 'testuser', got %q", user.Username)
	}
}

func TestValidateWebAppData_EmptyInitData(t *testing.T) {
	_, _, err := ValidateWebAppData("test-bot-token", "")
	if err == nil {
		t.Fatal("expected error for empty initData")
	}
}

func TestValidateWebAppData_MissingHash(t *testing.T) {
	params := url.Values{}
	params.Set("auth_date", fmt.Sprintf("%d", time.Now().Unix()))
	params.Set("user", `{"id":123456,"first_name":"Test"}`)
	initData := params.Encode()

	_, _, err := ValidateWebAppData("test-bot-token", initData)
	if err == nil {
		t.Fatal("expected error for missing hash")
	}
}

func TestValidateWebAppData_InvalidHash(t *testing.T) {
	token := "test-bot-token" // #nosec G101
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	initData := buildWebAppInitData(token, time.Now().Unix(), userJSON)

	// Tamper with the data by replacing the hash
	parsed, _ := url.ParseQuery(initData)
	parsed.Set("hash", "0000000000000000000000000000000000000000000000000000000000000000")
	tampered := parsed.Encode()

	valid, _, err := ValidateWebAppData(token, tampered)
	if err != nil {
		// Some implementations return error, some return valid=false
		return
	}
	if valid {
		t.Fatal("expected invalid signature for tampered data")
	}
}

func TestValidateWebAppData_ExpiredAuthDate(t *testing.T) {
	token := "test-bot-token" // #nosec G101
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	expiredTime := time.Now().Add(-25 * time.Hour).Unix()
	initData := buildWebAppInitData(token, expiredTime, userJSON)

	_, _, err := ValidateWebAppData(token, initData)
	if err == nil {
		t.Fatal("expected error for expired auth_date")
	}
}

func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		xrip       string
		trustProxy bool
		expected   string
	}{
		{
			name:       "trust proxy, use XFF",
			remoteAddr: "192.168.1.1:1234",
			xff:        "10.0.0.1, 10.0.0.2",
			trustProxy: true,
			expected:   "10.0.0.1",
		},
		{
			name:       "trust proxy, use X-Real-IP",
			remoteAddr: "192.168.1.1:1234",
			xrip:       "10.0.0.3",
			trustProxy: true,
			expected:   "10.0.0.3",
		},
		{
			name:       "distrust proxy, ignore headers",
			remoteAddr: "192.168.1.1:1234",
			xff:        "10.0.0.1, 10.0.0.2",
			xrip:       "10.0.0.3",
			trustProxy: false,
			expected:   "192.168.1.1",
		},
		{
			name:       "distrust proxy, no port",
			remoteAddr: "192.168.1.1",
			xff:        "10.0.0.1",
			trustProxy: false,
			expected:   "192.168.1.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			req.RemoteAddr = tt.remoteAddr
			if tt.xff != "" {
				req.Header.Set("X-Forwarded-For", tt.xff)
			}
			if tt.xrip != "" {
				req.Header.Set("X-Real-IP", tt.xrip)
			}

			actual := clientIP(req, tt.trustProxy)
			if actual != tt.expected {
				t.Errorf("Expected IP %q, got %q", tt.expected, actual)
			}
		})
	}
}

func TestValidateTelegramLoginWidget_ValidData(t *testing.T) {
	token := "test-bot-token" // #nosec G101
	data := buildLoginData(token, TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Unix(),
	})

	valid, user, err := ValidateTelegramLoginWidget(token, data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatal("expected valid signature")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.ID != 123456 {
		t.Errorf("expected user ID 123456, got %d", user.ID)
	}
	if user.FirstName != "Test" {
		t.Errorf("expected first name 'Test', got %q", user.FirstName)
	}
}

func TestValidateTelegramLoginWidget_InvalidHash(t *testing.T) {
	data := TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Unix(),
		Hash:      "0000000000000000000000000000000000000000000000000000000000000000",
	}

	valid, _, err := ValidateTelegramLoginWidget("test-bot-token", data)
	if err != nil {
		return
	}
	if valid {
		t.Fatal("expected invalid signature for wrong hash")
	}
}

func TestValidateTelegramLoginWidget_ExpiredAuthDate(t *testing.T) {
	token := "test-bot-token" // #nosec G101
	data := buildLoginData(token, TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Add(-25 * time.Hour).Unix(),
	})

	_, _, err := ValidateTelegramLoginWidget(token, data)
	if err == nil {
		t.Fatal("expected error for expired auth_date")
	}
}

// buildTelegramCallbackURL builds a GET URL with Telegram Login Widget query parameters.
func buildTelegramCallbackURL(data TelegramLoginData) string {
	q := url.Values{}
	q.Set("id", fmt.Sprintf("%d", data.ID))
	q.Set("auth_date", fmt.Sprintf("%d", data.AuthDate))
	q.Set("hash", data.Hash)
	if data.FirstName != "" {
		q.Set("first_name", data.FirstName)
	}
	if data.LastName != "" {
		q.Set("last_name", data.LastName)
	}
	if data.Username != "" {
		q.Set("username", data.Username)
	}
	if data.PhotoURL != "" {
		q.Set("photo_url", data.PhotoURL)
	}
	return "/auth/telegram/callback?" + q.Encode()
}

func TestHandleTelegramCallback_GET_ValidParams(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
		nonces:        newMockNonceStore(),
	}

	data := buildLoginData(token, TelegramLoginData{
		ID:        allowedID,
		FirstName: "Test",
		Username:  "testuser",
		AuthDate:  time.Now().Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, buildTelegramCallbackURL(data), nil)
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302, got %d", resp.StatusCode)
	}

	loc := resp.Header.Get("Location")
	if loc != "/" {
		t.Errorf("expected redirect to /, got %q", loc)
	}

	// Verify cache-busting header is set
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}

	// Verify auth cookie is set with correct security attributes
	var foundCookie bool
	for _, c := range resp.Cookies() {
		if c.Name == "auth_session" && c.Value != "" {
			foundCookie = true
			if !c.HttpOnly {
				t.Error("expected HttpOnly cookie")
			}
			if !c.Secure {
				t.Error("expected Secure cookie")
			}
			if c.SameSite != http.SameSiteLaxMode {
				t.Error("expected SameSite=Lax cookie")
			}
			if c.Path != "/" {
				t.Errorf("expected Path=/, got %q", c.Path)
			}
		}
	}
	if !foundCookie {
		t.Error("expected auth_session cookie to be set")
	}
}

func TestHandleTelegramCallback_GET_InvalidHash(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
	}

	data := TelegramLoginData{
		ID:        allowedID,
		FirstName: "Test",
		AuthDate:  time.Now().Unix(),
		Hash:      "0000000000000000000000000000000000000000000000000000000000000000",
	}

	req := httptest.NewRequest(http.MethodGet, buildTelegramCallbackURL(data), nil)
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store on error path, got %q", cc)
	}
}

func TestHandleTelegramCallback_GET_WrongUser(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
	}

	// Valid signature but for a different user ID
	data := buildLoginData(token, TelegramLoginData{
		ID:        999999,
		FirstName: "Evil",
		AuthDate:  time.Now().Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, buildTelegramCallbackURL(data), nil)
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store on error path, got %q", cc)
	}
}

func TestHandleTelegramCallback_POST_ValidJSON(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
		nonces:        newMockNonceStore(),
	}

	data := buildLoginData(token, TelegramLoginData{
		ID:        allowedID,
		FirstName: "Test",
		Username:  "testuser",
		AuthDate:  time.Now().Unix(),
	})

	body, _ := json.Marshal(data)
	req := httptest.NewRequest(http.MethodPost, "/auth/telegram/callback", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("expected application/json, got %q", ct)
	}

	respBody, _ := io.ReadAll(resp.Body)
	var result map[string]string
	if err := json.Unmarshal(respBody, &result); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if result["status"] != "ok" {
		t.Errorf("expected status=ok, got %q", result["status"])
	}

	// Verify cookie is set on POST too
	var foundCookie bool
	for _, c := range resp.Cookies() {
		if c.Name == "auth_session" && c.Value != "" {
			foundCookie = true
		}
	}
	if !foundCookie {
		t.Error("expected auth_session cookie to be set")
	}
}

func TestHandleTelegramCallback_POST_InvalidJSON(t *testing.T) {
	srv := &Server{
		botToken:      "test-bot-token",   // #nosec G101
		sessionSecret: "test-session-sec", // #nosec G101
		allowedUserID: 123456,
	}

	req := httptest.NewRequest(http.MethodPost, "/auth/telegram/callback", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestHandleTelegramCallback_POST_WrongUser(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
	}

	data := buildLoginData(token, TelegramLoginData{
		ID:        999999,
		FirstName: "Evil",
		AuthDate:  time.Now().Unix(),
	})

	body, _ := json.Marshal(data)
	req := httptest.NewRequest(http.MethodPost, "/auth/telegram/callback", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}
}

func TestHandleTelegramCallback_UnsupportedMethod(t *testing.T) {
	srv := &Server{
		botToken:      "test-bot-token",   // #nosec G101
		sessionSecret: "test-session-sec", // #nosec G101
		allowedUserID: 123456,
	}

	req := httptest.NewRequest(http.MethodPut, "/auth/telegram/callback", nil)
	w := httptest.NewRecorder()

	srv.handleTelegramCallback(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.StatusCode)
	}
}

func TestHandleTelegramCallback_GET_ReplayRejected(t *testing.T) {
	token := "test-bot-token"    // #nosec G101
	secret := "test-session-sec" // #nosec G101
	var allowedID int64 = 123456

	srv := &Server{
		botToken:      token,
		sessionSecret: secret,
		allowedUserID: allowedID,
		nonces:        newMockNonceStore(),
	}

	data := buildLoginData(token, TelegramLoginData{
		ID:        allowedID,
		FirstName: "Test",
		Username:  "testuser",
		AuthDate:  time.Now().Unix(),
	})

	// First request should succeed
	req1 := httptest.NewRequest(http.MethodGet, buildTelegramCallbackURL(data), nil)
	w1 := httptest.NewRecorder()
	srv.handleTelegramCallback(w1, req1)

	resp1 := w1.Result()
	defer resp1.Body.Close()
	if resp1.StatusCode != http.StatusFound {
		t.Fatalf("first request: expected 302, got %d", resp1.StatusCode)
	}

	// Second (replay) request with the same hash should be rejected
	req2 := httptest.NewRequest(http.MethodGet, buildTelegramCallbackURL(data), nil)
	w2 := httptest.NewRecorder()
	srv.handleTelegramCallback(w2, req2)

	resp2 := w2.Result()
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay request: expected 401, got %d", resp2.StatusCode)
	}
}
