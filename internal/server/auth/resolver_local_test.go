//go:build mobile

package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalUserResolver_AlwaysReturnsConfiguredUser(t *testing.T) {
	resolver := NewLocalUserResolver(User{ID: 1, FirstName: "Local", Username: "local"})

	req := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	got, err := resolver.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil {
		t.Fatal("expected user, got nil")
	}
	if got.ID != 1 {
		t.Errorf("ID = %d, want 1", got.ID)
	}
	if got.FirstName != "Local" {
		t.Errorf("FirstName = %q, want Local", got.FirstName)
	}
}

func TestLocalUserResolver_IgnoresRequestHeadersAndCookies(t *testing.T) {
	resolver := NewLocalUserResolver(User{ID: 42, FirstName: "Mobile"})

	// Even with a session cookie and initData header, the local resolver
	// still resolves to the configured user — request payload is ignored.
	req := httptest.NewRequest(http.MethodGet, "/api/x?initData=foo", nil)
	req.AddCookie(&http.Cookie{Name: "auth_session", Value: "anything"})
	req.Header.Set("X-Telegram-Init-Data", "anything")

	got, err := resolver.Resolve(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != 42 {
		t.Errorf("expected fixed ID=42, got %d", got.ID)
	}
}

func TestLocalUserResolver_ReturnsCopy(t *testing.T) {
	original := User{ID: 7, FirstName: "Original"}
	resolver := NewLocalUserResolver(original)

	got, _ := resolver.Resolve(httptest.NewRequest(http.MethodGet, "/", nil))
	got.FirstName = "Mutated"

	// Second resolve should be unaffected by the first caller's mutation.
	got2, _ := resolver.Resolve(httptest.NewRequest(http.MethodGet, "/", nil))
	if got2.FirstName != "Original" {
		t.Errorf("caller mutated shared user state: got %q, want %q", got2.FirstName, "Original")
	}
}
