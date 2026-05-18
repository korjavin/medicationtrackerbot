package mcp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
)

type fakeAdminStore struct {
	mu        sync.Mutex
	tokens    map[int64]*store.APIToken
	hashes    map[string]int64
	nextID    int64
	createErr error
	listErr   error
	deleteErr error
}

func newFakeAdminStore() *fakeAdminStore {
	return &fakeAdminStore{
		tokens: make(map[int64]*store.APIToken),
		hashes: make(map[string]int64),
		nextID: 0,
	}
}

func (f *fakeAdminStore) CreateToken(_ context.Context, name, hash string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return 0, f.createErr
	}
	if _, exists := f.hashes[hash]; exists {
		return 0, errors.New("UNIQUE constraint failed")
	}
	f.nextID++
	id := f.nextID
	f.tokens[id] = &store.APIToken{
		ID:        id,
		Name:      name,
		CreatedAt: time.Now().UTC(),
	}
	f.hashes[hash] = id
	return id, nil
}

func (f *fakeAdminStore) ListTokens(_ context.Context) ([]store.APIToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]store.APIToken, 0, len(f.tokens))
	for id := int64(1); id <= f.nextID; id++ {
		if t, ok := f.tokens[id]; ok {
			out = append(out, *t)
		}
	}
	return out, nil
}

func (f *fakeAdminStore) DeleteToken(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteErr != nil {
		return f.deleteErr
	}
	if _, ok := f.tokens[id]; !ok {
		return sql.ErrNoRows
	}
	delete(f.tokens, id)
	for h, hid := range f.hashes {
		if hid == id {
			delete(f.hashes, h)
		}
	}
	return nil
}

func (f *fakeAdminStore) hashFor(id int64) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for h, hid := range f.hashes {
		if hid == id {
			return h, true
		}
	}
	return "", false
}

func doRequest(t *testing.T, h http.Handler, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestAdminHandler_CreateToken(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	rr := doRequest(t, mux, http.MethodPost, "/admin/tokens", `{"name":"ci-bot"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rr.Code, rr.Body.String())
	}

	var resp createTokenResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID <= 0 {
		t.Errorf("expected positive id, got %d", resp.ID)
	}
	if resp.Name != "ci-bot" {
		t.Errorf("name = %q, want %q", resp.Name, "ci-bot")
	}
	if !strings.HasPrefix(resp.Token, auth.TokenPrefix) {
		t.Errorf("token %q lacks prefix %q", resp.Token, auth.TokenPrefix)
	}
	// "mcp_" + 64 hex chars (32 bytes) = 68 chars
	const tokenRandBytes = 32
	if want := len(auth.TokenPrefix) + tokenRandBytes*2; len(resp.Token) != want {
		t.Errorf("token length = %d, want %d", len(resp.Token), want)
	}

	// Hash stored matches sha256 of plaintext.
	sum := sha256.Sum256([]byte(resp.Token))
	wantHash := hex.EncodeToString(sum[:])
	gotHash, ok := fs.hashFor(resp.ID)
	if !ok {
		t.Fatalf("no hash recorded for id %d", resp.ID)
	}
	if gotHash != wantHash {
		t.Errorf("stored hash = %q, want %q", gotHash, wantHash)
	}

	// Content-Type should be JSON.
	if ct := rr.Result().Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestAdminHandler_CreateToken_BadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty body", ""},
		{"empty name", `{"name":""}`},
		{"whitespace name", `{"name":"   "}`},
		{"name too long", fmt.Sprintf(`{"name":%q}`, strings.Repeat("a", maxAPITokenNameLen+1))},
		{"malformed json", `{"name":`},
		{"name with newline", `{"name":"foo\nbar"}`},
		{"name with control byte", "{\"name\":\"foo\\u0001bar\"}"},
		{"name with colon (would confuse subject parsing)", `{"name":"foo:bar"}`},
		{"name with non-ascii", `{"name":"føø"}`},
		{"name with slash", `{"name":"foo/bar"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := newFakeAdminStore()
			mux := NewAdminHandler(fs).Mux()

			rr := doRequest(t, mux, http.MethodPost, "/admin/tokens", tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400, body=%s", rr.Code, rr.Body.String())
			}
			if len(fs.tokens) != 0 {
				t.Errorf("unexpected token rows after bad input: %d", len(fs.tokens))
			}
		})
	}
}

func TestAdminHandler_ListTokens(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	// Empty list initially.
	rr := doRequest(t, mux, http.MethodGet, "/admin/tokens", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rr.Code, rr.Body.String())
	}
	var first []listedToken
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(first) != 0 {
		t.Errorf("expected empty list, got %d", len(first))
	}

	// Create two tokens, then list.
	for _, name := range []string{"alpha", "beta"} {
		rr := doRequest(t, mux, http.MethodPost, "/admin/tokens", fmt.Sprintf(`{"name":%q}`, name))
		if rr.Code != http.StatusCreated {
			t.Fatalf("create %s: status %d body %s", name, rr.Code, rr.Body.String())
		}
	}

	rr = doRequest(t, mux, http.MethodGet, "/admin/tokens", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", rr.Code)
	}
	var got []listedToken
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d tokens, want 2", len(got))
	}
	if got[0].Name != "alpha" || got[1].Name != "beta" {
		t.Errorf("order: got [%s, %s], want [alpha, beta]", got[0].Name, got[1].Name)
	}
	if got[0].LastUsedAt != nil {
		t.Errorf("expected last_used_at null on fresh token, got %v", *got[0].LastUsedAt)
	}
	if got[0].CreatedAt == "" {
		t.Errorf("expected created_at populated")
	}
}

func TestAdminHandler_DeleteToken(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	createRR := doRequest(t, mux, http.MethodPost, "/admin/tokens", `{"name":"to-delete"}`)
	if createRR.Code != http.StatusCreated {
		t.Fatalf("create status = %d", createRR.Code)
	}
	var created createTokenResponse
	if err := json.Unmarshal(createRR.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}

	rr := doRequest(t, mux, http.MethodDelete, fmt.Sprintf("/admin/tokens/%d", created.ID), "")
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204, body=%s", rr.Code, rr.Body.String())
	}

	listRR := doRequest(t, mux, http.MethodGet, "/admin/tokens", "")
	var got []listedToken
	if err := json.Unmarshal(listRR.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty list after delete, got %d", len(got))
	}
}

func TestAdminHandler_DeleteToken_NotFound(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	rr := doRequest(t, mux, http.MethodDelete, "/admin/tokens/9999", "")
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body=%s", rr.Code, rr.Body.String())
	}
}

func TestAdminHandler_DeleteToken_BadID(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	cases := []string{
		"/admin/tokens/abc",
		"/admin/tokens/0",
		"/admin/tokens/-3",
	}
	for _, target := range cases {
		t.Run(target, func(t *testing.T) {
			rr := doRequest(t, mux, http.MethodDelete, target, "")
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400, body=%s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestAdminHandler_TokensAreUnique(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	const n = 20
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		rr := doRequest(t, mux, http.MethodPost, "/admin/tokens", fmt.Sprintf(`{"name":"t%d"}`, i))
		if rr.Code != http.StatusCreated {
			t.Fatalf("create %d: status %d", i, rr.Code)
		}
		var resp createTokenResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if _, dup := seen[resp.Token]; dup {
			t.Fatalf("duplicate token generated: %s", resp.Token)
		}
		seen[resp.Token] = struct{}{}
	}
}

// Confirm *auth.Repo satisfies AdminStore at compile time.
func TestStoreImplementsAdminStore(t *testing.T) {
	var _ AdminStore = (*auth.Repo)(nil)
}

// TestAdminHandler_ListTokens_NeverIncludesPlaintext pins the security
// invariant that GET /admin/tokens does not echo back the plaintext token —
// the plaintext is shown only once at creation.
func TestAdminHandler_ListTokens_NeverIncludesPlaintext(t *testing.T) {
	fs := newFakeAdminStore()
	mux := NewAdminHandler(fs).Mux()

	createRR := doRequest(t, mux, http.MethodPost, "/admin/tokens", `{"name":"sensitive"}`)
	if createRR.Code != http.StatusCreated {
		t.Fatalf("create status = %d", createRR.Code)
	}
	var created createTokenResponse
	if err := json.Unmarshal(createRR.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Token == "" {
		t.Fatalf("create did not return plaintext")
	}

	listRR := doRequest(t, mux, http.MethodGet, "/admin/tokens", "")
	if listRR.Code != http.StatusOK {
		t.Fatalf("list status = %d", listRR.Code)
	}
	body := listRR.Body.String()
	if strings.Contains(body, created.Token) {
		t.Fatalf("list response leaked plaintext token: %s", body)
	}
	if strings.Contains(body, auth.TokenPrefix) {
		t.Fatalf("list response contains %q prefix — plaintext leak suspected: %s",
			auth.TokenPrefix, body)
	}
}

// TestAdminHandler_StoreErrorPaths exercises the 500 branches that depend on
// the underlying store returning errors, ensuring the response surfaces a
// generic error message rather than leaking internal error text.
func TestAdminHandler_StoreErrorPaths(t *testing.T) {
	t.Run("create error", func(t *testing.T) {
		fs := newFakeAdminStore()
		fs.createErr = errors.New("simulated db failure: secret-internal-detail")
		mux := NewAdminHandler(fs).Mux()
		rr := doRequest(t, mux, http.MethodPost, "/admin/tokens", `{"name":"x"}`)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rr.Code)
		}
		if strings.Contains(rr.Body.String(), "secret-internal-detail") {
			t.Errorf("response leaked internal error: %s", rr.Body.String())
		}
	})

	t.Run("list error", func(t *testing.T) {
		fs := newFakeAdminStore()
		fs.listErr = errors.New("simulated db failure: another-secret")
		mux := NewAdminHandler(fs).Mux()
		rr := doRequest(t, mux, http.MethodGet, "/admin/tokens", "")
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rr.Code)
		}
		if strings.Contains(rr.Body.String(), "another-secret") {
			t.Errorf("response leaked internal error: %s", rr.Body.String())
		}
	})

	t.Run("delete error (not ErrNoRows)", func(t *testing.T) {
		fs := newFakeAdminStore()
		// Pre-create a token so the path passes the not-found check, then
		// trip the delete error.
		if _, err := fs.CreateToken(context.Background(), "x", "h"); err != nil {
			t.Fatalf("seed: %v", err)
		}
		fs.deleteErr = errors.New("simulated db failure: delete-secret")
		mux := NewAdminHandler(fs).Mux()
		rr := doRequest(t, mux, http.MethodDelete, "/admin/tokens/1", "")
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rr.Code)
		}
		if strings.Contains(rr.Body.String(), "delete-secret") {
			t.Errorf("response leaked internal error: %s", rr.Body.String())
		}
	})
}
