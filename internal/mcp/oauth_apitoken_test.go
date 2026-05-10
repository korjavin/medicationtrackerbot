package mcp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type fakeAPITokenStore struct {
	byHash      map[string]*store.APIToken
	findErr     error
	touchErr    error
	touchedIDs  []int64
	findCalls   int
	missingHash bool
}

func (f *fakeAPITokenStore) FindAPITokenByHash(_ context.Context, hash string) (*store.APIToken, error) {
	f.findCalls++
	if f.findErr != nil {
		return nil, f.findErr
	}
	tok, ok := f.byHash[hash]
	if !ok {
		f.missingHash = true
		return nil, nil
	}
	return tok, nil
}

func (f *fakeAPITokenStore) TouchAPITokenLastUsed(_ context.Context, id int64) error {
	f.touchedIDs = append(f.touchedIDs, id)
	return f.touchErr
}

func newFakeStoreWithToken(token, name string, id int64) *fakeAPITokenStore {
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	return &fakeAPITokenStore{
		byHash: map[string]*store.APIToken{
			hash: {
				ID:        id,
				Name:      name,
				CreatedAt: time.Now(),
			},
		},
	}
}

func TestMiddleware_APIToken(t *testing.T) {
	const validToken = "mcp_validtoken1234567890"

	tests := []struct {
		name           string
		authHeader     string
		store          func() *fakeAPITokenStore
		wantStatus     int
		wantSubject    string
		wantTouchedIDs int
		wantBodyOK     bool
	}{
		{
			name:           "valid api token authorizes",
			authHeader:     "Bearer " + validToken,
			store:          func() *fakeAPITokenStore { return newFakeStoreWithToken(validToken, "ci-bot", 42) },
			wantStatus:     http.StatusOK,
			wantSubject:    "api-token:ci-bot",
			wantTouchedIDs: 1,
			wantBodyOK:     true,
		},
		{
			name:       "unknown api token rejected",
			authHeader: "Bearer mcp_doesnotexist",
			store: func() *fakeAPITokenStore {
				return &fakeAPITokenStore{byHash: map[string]*store.APIToken{}}
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "lookup error rejected",
			authHeader: "Bearer mcp_anytoken",
			store: func() *fakeAPITokenStore {
				return &fakeAPITokenStore{
					byHash:  map[string]*store.APIToken{},
					findErr: errors.New("db down"),
				}
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing authorization header rejected",
			authHeader: "",
			store: func() *fakeAPITokenStore {
				return &fakeAPITokenStore{byHash: map[string]*store.APIToken{}}
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing bearer prefix rejected",
			authHeader: validToken,
			store: func() *fakeAPITokenStore {
				return &fakeAPITokenStore{byHash: map[string]*store.APIToken{}}
			},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fakeStore := tt.store()
			cfg := &Config{
				AllowedSubject: "test-user",
				MCPServerURL:   "https://mcp.example.com",
				ClientID:       "test-client",
			}
			h := NewOAuthHandler(cfg, fakeStore)

			var gotSubject string
			handler := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if v, ok := r.Context().Value(UserSubjectCtxKey).(string); ok {
					gotSubject = v
				}
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("ok"))
			}))

			req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body=%q)", rr.Code, tt.wantStatus, rr.Body.String())
			}
			if tt.wantSubject != "" && gotSubject != tt.wantSubject {
				t.Errorf("subject = %q, want %q", gotSubject, tt.wantSubject)
			}
			if got, want := len(fakeStore.touchedIDs), tt.wantTouchedIDs; got != want {
				t.Errorf("touched IDs len = %d, want %d", got, want)
			}
			if tt.wantBodyOK && rr.Body.String() != "ok" {
				t.Errorf("body = %q, want %q", rr.Body.String(), "ok")
			}
		})
	}
}

func TestMiddleware_APITokenStoreNil(t *testing.T) {
	cfg := &Config{
		MCPServerURL: "https://mcp.example.com",
		ClientID:     "test-client",
	}
	h := NewOAuthHandler(cfg, nil)

	called := false
	handler := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer mcp_anytoken")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if called {
		t.Errorf("next handler should not be called when store is nil")
	}
}

func TestMiddleware_NonAPITokenFallsThroughToJWT(t *testing.T) {
	cfg := &Config{
		PocketIDURL:  "https://expected-issuer.example",
		MCPServerURL: "https://mcp.example.com",
		ClientID:     "test-client",
	}
	fakeStore := &fakeAPITokenStore{byHash: map[string]*store.APIToken{}}
	h := NewOAuthHandler(cfg, fakeStore)

	called := false
	handler := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	// A garbage non-mcp_-prefixed bearer must fall through to validateToken
	// and be rejected as a malformed JWT (not as an API token).
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer not-a-jwt-and-no-prefix")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if called {
		t.Errorf("next handler should not be called for invalid JWT")
	}
	// Critically: the API-token store must NOT have been consulted because
	// the bearer value lacks the mcp_ prefix.
	if fakeStore.findCalls != 0 {
		t.Errorf("expected 0 store lookups for non-mcp_ bearer, got %d", fakeStore.findCalls)
	}
}

// Sanity check that *store.Store satisfies APITokenStore at compile time.
func TestStoreImplementsAPITokenStore(t *testing.T) {
	var _ APITokenStore = (*store.Store)(nil)

	// And that the lookup signature returns sql.ErrNoRows-mapped nil.
	var s APITokenStore = &fakeAPITokenStore{
		byHash: map[string]*store.APIToken{},
	}
	tok, err := s.FindAPITokenByHash(context.Background(), "missing")
	if err != nil {
		t.Fatalf("FindAPITokenByHash: %v", err)
	}
	if tok != nil {
		t.Fatalf("expected nil, got %+v", tok)
	}
	// Sanity: sql.ErrNoRows is exported (avoid unused import).
	_ = sql.ErrNoRows
}
