package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestPutEgressHosts guards the endpoint's real contract through the router:
// bare hostnames persist for the session account, and anything that could
// smuggle a scheme/path/space or blow the count cap is rejected (400) before it
// can widen the emitted connect-src.
func TestPutEgressHosts(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	egressAPI := NewEgressAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	egressAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	put := func(hosts []string) int {
		body, _ := json.Marshal(egressHostsRequest{Hosts: hosts})
		r := httptest.NewRequest(http.MethodPut, "/api/egress-hosts", bytes.NewReader(body))
		r.Host = host
		r.AddCookie(session)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}

	// Valid hostnames persist and read back normalized (deduped, sorted).
	if code := put([]string{"api.openai.com", "fooddb.example.com", "api.openai.com"}); code != http.StatusNoContent {
		t.Fatalf("valid PUT status = %d, want 204", code)
	}
	stored, err := store.EgressHosts(context.Background(), account.ID)
	if err != nil {
		t.Fatalf("EgressHosts: %v", err)
	}
	if len(stored) != 2 || stored[0] != "api.openai.com" || stored[1] != "fooddb.example.com" {
		t.Fatalf("stored = %v, want [api.openai.com fooddb.example.com]", stored)
	}

	// Each of these must be rejected before storage.
	bad := map[string][]string{
		"scheme":     {"https://api.openai.com"},
		"path":       {"api.openai.com/v1"},
		"port":       {"api.openai.com:443"},
		"space":      {"api.openai.com evil.com"},
		"uppercase":  {"API.openai.com"},
		"leading dot": {".openai.com"},
		"too many":   {"a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com", "h.com", "i.com"},
	}
	for name, hosts := range bad {
		if code := put(hosts); code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, code)
		}
	}

	// A rejected PUT must not have clobbered the previously-stored good list.
	stored, err = store.EgressHosts(context.Background(), account.ID)
	if err != nil {
		t.Fatalf("EgressHosts after rejects: %v", err)
	}
	if len(stored) != 2 {
		t.Fatalf("stored list changed after rejected PUTs: %v", stored)
	}
}
