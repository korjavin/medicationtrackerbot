package cloudserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

func newTestInviteHandler(t *testing.T) (http.Handler, *cloudstore.Repo, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)

	mux := http.NewServeMux()
	NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long").RegisterRoutes(mux)
	NewInviteAPI(store, "test-session-secret-at-least-32-bytes-long", "localhost", 14*24*time.Hour).RegisterRoutes(mux)

	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	return h, store, account.Subdomain + ".localhost", claimToken
}

func postInvite(t *testing.T, h http.Handler, host string, session *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/invite", nil)
	req.Host = host
	if session != nil {
		req.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestInviteAPI_Contract covers the whole /api/invite boundary: unauthenticated
// callers are rejected, a session mints a claimable invite attributed to the
// caller, and the rolling quota returns 429 once it's exhausted.
func TestInviteAPI_Contract(t *testing.T) {
	h, store, host, claimToken := newTestInviteHandler(t)

	if rec := postInvite(t, h, host, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /api/invite without session = %d, want 401", rec.Code)
	}

	session := registerAndGetSession(t, h, host, claimToken)
	accountID, _, ok := VerifySessionToken(session.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("could not verify session token")
	}

	rec := postInvite(t, h, host, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/invite = %d, body %q", rec.Code, rec.Body.String())
	}
	var got inviteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal invite response: %v", err)
	}
	want := regexp.MustCompile(`^https://` + regexp.QuoteMeta(got.Subdomain) + `\.localhost/#claim=[0-9a-f]{64}$`)
	if !want.MatchString(got.ClaimURL) {
		t.Errorf("claim_url = %q, want match %s", got.ClaimURL, want)
	}
	if !got.ExpiresAt.After(time.Now()) {
		t.Errorf("expires_at = %v, want in the future", got.ExpiresAt)
	}

	n, err := store.CountAccountsCreatedBy(t.Context(), accountID, time.Now().Add(-inviteQuotaWindow))
	if err != nil {
		t.Fatalf("CountAccountsCreatedBy: %v", err)
	}
	if n != 1 {
		t.Fatalf("accounts created by %s = %d, want 1 (provenance not recorded)", accountID, n)
	}

	// Fill the remaining quota directly in the store, then the next mint 429s.
	now := time.Now().UTC()
	for i := n; i < inviteMonthlyQuota; i++ {
		id := fmt.Sprintf("seed-account-%d", i)
		if _, err := store.CreateAccount(t.Context(), id, id, []byte("hash"), now.Add(24*time.Hour), now, "", "", accountID); err != nil {
			t.Fatalf("seed account %d: %v", i, err)
		}
	}

	rec = postInvite(t, h, host, session)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("POST /api/invite at quota = %d, want 429", rec.Code)
	}
	var quotaErr inviteQuotaError
	if err := json.Unmarshal(rec.Body.Bytes(), &quotaErr); err != nil {
		t.Fatalf("unmarshal quota error: %v", err)
	}
	if quotaErr.Limit != inviteMonthlyQuota || quotaErr.WindowDays != 30 {
		t.Errorf("quota error = %+v, want limit=%d window_days=30", quotaErr, inviteMonthlyQuota)
	}
}
