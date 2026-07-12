package cloudserver

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newRxNavTestHandlerAPI mirrors cmd/cloud/main.go's wiring for the RxNav
// proxy so the tests drive the real subdomain-routing + session + proxy
// contract. The mock upstream serves as BOTH baseURL and interactionURL.
func newRxNavTestHandlerAPI(t *testing.T, upstreamURL string) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	secret := "test-session-secret-at-least-32-bytes-long"

	webauthnAPI := NewWebAuthnAPI(store, secret)
	proxyAPI := NewRxNavProxyAPI(store, secret, upstreamURL, upstreamURL)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	proxyAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), host, claimToken
}

func TestRxNavProxyAPI(t *testing.T) {
	var interactionRawQuery string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/REST/rxcui.json":
			if r.URL.Query().Get("name") == "aspirin" {
				w.Write([]byte(`{"idGroup": {"rxnormId": ["1191"]}}`))
				return
			}
			w.Write([]byte(`{"idGroup": {}}`))
		case r.URL.Path == "/REST/approximateTerm.json":
			w.Write([]byte(`{"approximateGroup": {"candidate": [{"rxcui": "1191"}]}}`))
		case r.URL.Path == "/REST/rxcui/1191/properties.json":
			w.Write([]byte(`{"properties": {"rxcui": "1191", "name": "aspirin"}}`))
		case r.URL.Path == "/api/interaction/list.json":
			interactionRawQuery = r.URL.RawQuery
			w.Write([]byte(`{"fullInteractionTypeGroup": []}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()

	handler, host, claimToken := newRxNavTestHandlerAPI(t, mock.URL)
	session := registerAndGetSession(t, handler, host, claimToken)

	get := func(t *testing.T, path string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
		req.AddCookie(session)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}

	t.Run("Rxcui routes correctly", func(t *testing.T) {
		w := get(t, "/api/rxnav/rxcui?name=aspirin")
		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}
		var resp struct {
			IDGroup struct {
				RxnormID []string `json:"rxnormId"`
			} `json:"idGroup"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}
		if len(resp.IDGroup.RxnormID) != 1 || resp.IDGroup.RxnormID[0] != "1191" {
			t.Errorf("Unexpected response: %s", w.Body.String())
		}
	})

	t.Run("Approximate routes correctly", func(t *testing.T) {
		w := get(t, "/api/rxnav/approximate?term=asprin")
		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}
		if !strings.Contains(w.Body.String(), `"rxcui": "1191"`) {
			t.Errorf("Unexpected response: %s", w.Body.String())
		}
	})

	t.Run("Properties routes correctly", func(t *testing.T) {
		w := get(t, "/api/rxnav/properties?rxcui=1191")
		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}
		if !strings.Contains(w.Body.String(), `"name": "aspirin"`) {
			t.Errorf("Unexpected response: %s", w.Body.String())
		}
	})

	t.Run("Interactions joins digit parts with plus", func(t *testing.T) {
		w := get(t, "/api/rxnav/interactions?rxcuis=1191,207106")
		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}
		if interactionRawQuery != "rxcuis=1191+207106" {
			t.Errorf("upstream saw query %q, want rxcuis=1191+207106", interactionRawQuery)
		}
	})

	t.Run("Interactions rejects non-numeric rxcuis", func(t *testing.T) {
		for _, bad := range []string{"1191,abc", "1191,,207106", "../etc"} {
			w := get(t, "/api/rxnav/interactions?rxcuis="+bad)
			if w.Code != http.StatusBadRequest {
				t.Errorf("rxcuis=%q: expected 400, got %d", bad, w.Code)
			}
		}
	})

	t.Run("Missing params get 400", func(t *testing.T) {
		for _, path := range []string{
			"/api/rxnav/rxcui",
			"/api/rxnav/approximate",
			"/api/rxnav/properties",
			"/api/rxnav/interactions",
		} {
			w := get(t, path)
			if w.Code != http.StatusBadRequest {
				t.Errorf("%s: expected 400, got %d", path, w.Code)
			}
		}
	})

	t.Run("Requires session", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/rxnav/rxcui?name=aspirin", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected 401, got %d", w.Code)
		}
	})
}

// TestRxNavProxy_UpstreamFailureLogsNoQuery: http.Client.Do errors are
// *url.Error values whose Error() embeds the full upstream URL — including
// the drug name. The blind-proxy invariant requires the logged error to be
// the unwrapped cause only.
func TestRxNavProxy_UpstreamFailureLogsNoQuery(t *testing.T) {
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	// A closed server yields a connection-refused *url.Error from client.Do.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	handler, host, claimToken := newRxNavTestHandlerAPI(t, deadURL)
	session := registerAndGetSession(t, handler, host, claimToken)

	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/rxnav/rxcui?name=supersecretdrugname", nil)
	req.AddCookie(session)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504", w.Code)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "rxnavproxy: upstream request failed") {
		t.Fatalf("expected an upstream-failure log line, got %q", logged)
	}
	if strings.Contains(logged, "supersecretdrugname") {
		t.Errorf("SECURITY INVARIANT: log leaked the drug name: %q", logged)
	}
}
