package cloudserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
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

// TestInviteQuotaIgnoresManagebotProvenance pins the two-way isolation the
// managebot's "tg:<uid>" provenance keys rely on: created_by_account_id is
// matched by exact equality, so a session's account id never sees managebot
// rows and vice versa. Without this, the managebot's mints would eat into a
// user's 100/30d quota.
func TestInviteQuotaIgnoresManagebotProvenance(t *testing.T) {
	h, store, host, claimToken := newTestInviteHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID, _, ok := VerifySessionToken(session.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("could not verify session token")
	}

	// Exhaust the monthly quota's worth of rows — but attributed to a managebot
	// creator key, not to this account.
	now := time.Now().UTC()
	for i := 0; i < inviteMonthlyQuota; i++ {
		if _, err := Provision(t.Context(), store, 14*24*time.Hour, now, tgCreator); err != nil {
			t.Fatalf("seed managebot mint %d: %v", i, err)
		}
	}

	if rec := postInvite(t, h, host, session); rec.Code != http.StatusOK {
		t.Fatalf("POST /api/invite = %d, want 200 (managebot rows must not consume the account quota)", rec.Code)
	}

	since := now.Add(-inviteQuotaWindow)
	n, err := store.CountAccountsCreatedBy(t.Context(), accountID, since)
	if err != nil {
		t.Fatalf("CountAccountsCreatedBy(%s): %v", accountID, err)
	}
	if n != 1 {
		t.Errorf("accounts created by %s = %d, want 1 (managebot rows leaked into the account quota)", accountID, n)
	}

	n, err = store.CountAccountsCreatedBy(t.Context(), tgCreator, since)
	if err != nil {
		t.Fatalf("CountAccountsCreatedBy(%s): %v", tgCreator, err)
	}
	if n != inviteMonthlyQuota {
		t.Errorf("accounts created by %s = %d, want %d (account mint leaked into the managebot quota)", tgCreator, n, inviteMonthlyQuota)
	}
}

// TestInviteAPI_ConcurrentMintsRespectQuota pins that the quota check and the
// account insert are serialized: without the lock, concurrent mints all read a
// sub-quota count and every one of them provisions an account.
func TestInviteAPI_ConcurrentMintsRespectQuota(t *testing.T) {
	h, store, host, claimToken := newTestInviteHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID, _, ok := VerifySessionToken(session.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("could not verify session token")
	}

	// Leave exactly one slot free, then race 8 mints for it.
	now := time.Now().UTC()
	for i := 0; i < inviteMonthlyQuota-1; i++ {
		id := fmt.Sprintf("seed-account-%d", i)
		if _, err := store.CreateAccount(t.Context(), id, id, []byte("hash"), now.Add(24*time.Hour), now, "", "", accountID); err != nil {
			t.Fatalf("seed account %d: %v", i, err)
		}
	}

	const racers = 8
	var wg sync.WaitGroup
	codes := make([]int, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = postInvite(t, h, host, session).Code
		}()
	}
	wg.Wait()

	granted := 0
	for i, code := range codes {
		switch code {
		case http.StatusOK:
			granted++
		case http.StatusTooManyRequests:
		default:
			t.Fatalf("mint %d = %d, want 200 or 429", i, code)
		}
	}
	if granted != 1 {
		t.Errorf("granted %d mints for 1 free slot, want 1", granted)
	}

	n, err := store.CountAccountsCreatedBy(t.Context(), accountID, time.Now().Add(-inviteQuotaWindow))
	if err != nil {
		t.Fatalf("CountAccountsCreatedBy: %v", err)
	}
	if n != inviteMonthlyQuota {
		t.Errorf("accounts created by %s = %d, want %d (quota exceeded)", accountID, n, inviteMonthlyQuota)
	}
}

// TestInviteAPI_ExpiredInvitesFreeQuota pins the documented quota semantics:
// the limit counts *users* created, so an unclaimed invite that expired must
// give its slot back even to the account that is already at the limit.
func TestInviteAPI_ExpiredInvitesFreeQuota(t *testing.T) {
	h, store, host, claimToken := newTestInviteHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID, _, ok := VerifySessionToken(session.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("could not verify session token")
	}

	now := time.Now().UTC()
	for i := 0; i < inviteMonthlyQuota; i++ {
		id := fmt.Sprintf("expired-account-%d", i)
		if _, err := store.CreateAccount(t.Context(), id, id, []byte("hash"), now.Add(-time.Hour), now, "", "", accountID); err != nil {
			t.Fatalf("seed expired account %d: %v", i, err)
		}
	}

	if rec := postInvite(t, h, host, session); rec.Code != http.StatusOK {
		t.Fatalf("POST /api/invite after expired invites = %d, want 200 (sweep must free quota)", rec.Code)
	}
}
