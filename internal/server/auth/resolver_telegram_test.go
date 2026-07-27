package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// stubValidator returns a ValidateInitDataFunc that returns the given outcome
// regardless of input.
func stubValidator(valid bool, user *User, err error) ValidateInitDataFunc {
	return func(token, initData string) (bool, *User, error) {
		return valid, user, err
	}
}

// stubVerifier returns a VerifySessionFunc that returns the given outcome
// regardless of input.
func stubVerifier(email string, ok bool) VerifySessionFunc {
	return func(token, secret string) (string, bool) {
		return email, ok
	}
}

func TestTelegramOIDCResolver_OIDCSessionCookieValid(t *testing.T) {
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		42,
		stubValidator(false, nil, errors.New("should not be called")),
		stubVerifier("admin@example.com", true),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.AddCookie(&http.Cookie{Name: "auth_session", Value: "any-token"})

	user, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil {
		t.Fatal("expected user, got nil")
	}
	if user.ID != 42 {
		t.Errorf("expected ID=42 (allowedUserID), got %d", user.ID)
	}
	if user.Username != "admin@example.com" {
		t.Errorf("expected Username=admin@example.com, got %q", user.Username)
	}
	if user.FirstName != "Admin" || user.LastName != "(OIDC)" {
		t.Errorf("expected OIDC dummy name fields, got FirstName=%q LastName=%q", user.FirstName, user.LastName)
	}
}

func TestTelegramOIDCResolver_OIDCSessionCookieInvalidFallsThroughToInitData(t *testing.T) {
	// Cookie present but verifier rejects → must fall through to initData.
	validUser := &User{ID: 42, FirstName: "Test", Username: "testuser"}
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		42,
		stubValidator(true, validUser, nil),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=foo", nil)
	req.AddCookie(&http.Cookie{Name: "auth_session", Value: "bad"})

	user, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil || user.ID != 42 {
		t.Fatalf("expected initData fallback to succeed, got user=%+v", user)
	}
}

func TestTelegramOIDCResolver_InitDataInHeader(t *testing.T) {
	validUser := &User{ID: 99, FirstName: "Test", Username: "testuser"}
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		99,
		stubValidator(true, validUser, nil),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("X-Telegram-Init-Data", "any-non-empty")

	user, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil || user.ID != 99 {
		t.Fatalf("expected user ID=99, got %+v", user)
	}
}

func TestTelegramOIDCResolver_InitDataInQuery(t *testing.T) {
	validUser := &User{ID: 7, FirstName: "Test", Username: "testuser"}
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		7,
		stubValidator(true, validUser, nil),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=foo", nil)
	user, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user == nil || user.ID != 7 {
		t.Fatalf("expected user ID=7, got %+v", user)
	}
}

func TestTelegramOIDCResolver_NoAuth(t *testing.T) {
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		1,
		stubValidator(false, nil, errors.New("should not be called")),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	_, err := r.Resolve(req)
	if !errors.Is(err, ErrNoAuth) {
		t.Fatalf("expected ErrNoAuth, got %v", err)
	}
}

func TestTelegramOIDCResolver_InvalidInitData(t *testing.T) {
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		1,
		stubValidator(false, nil, errors.New("hash mismatch")),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=tampered", nil)
	_, err := r.Resolve(req)
	if !errors.Is(err, ErrInvalidAuth) {
		t.Fatalf("expected ErrInvalidAuth, got %v", err)
	}
}

func TestTelegramOIDCResolver_InitDataValidationReturnsValidFalseNoError(t *testing.T) {
	// Defensive: valid=false with nil error should still be ErrInvalidAuth.
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		1,
		stubValidator(false, nil, nil),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=bad", nil)
	_, err := r.Resolve(req)
	if !errors.Is(err, ErrInvalidAuth) {
		t.Fatalf("expected ErrInvalidAuth, got %v", err)
	}
}

func TestTelegramOIDCResolver_WrongUser(t *testing.T) {
	// Validator returns a valid user but with a different ID than allowedUserID.
	wrongUser := &User{ID: 999, Username: "evil"}
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		42,
		stubValidator(true, wrongUser, nil),
		stubVerifier("", false),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=foo", nil)
	_, err := r.Resolve(req)
	if !errors.Is(err, ErrUserNotAllowed) {
		t.Fatalf("expected ErrUserNotAllowed, got %v", err)
	}
}

func TestTelegramOIDCResolver_CookiePreferredOverInitData(t *testing.T) {
	// When both cookie and initData are present and the cookie verifier
	// succeeds, the initData validator must NOT be called.
	initDataCalled := false
	r := NewTelegramOIDCResolver(
		"bot-token",
		"session-secret",
		42,
		func(token, initData string) (bool, *User, error) {
			initDataCalled = true
			return true, &User{ID: 42}, nil
		},
		stubVerifier("admin@example.com", true),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=foo", nil)
	req.AddCookie(&http.Cookie{Name: "auth_session", Value: "good"})

	user, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.Username != "admin@example.com" {
		t.Errorf("expected OIDC user, got %+v", user)
	}
	if initDataCalled {
		t.Error("expected initData validator NOT to be called when cookie is valid")
	}
}
