package cloudserver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// inviteAdmin is the admin's Telegram user id (= its private chat id).
const inviteAdmin int64 = 555

type fakeMail struct{ to, subject, body string }

type fakeMailer struct {
	mu    sync.Mutex
	sends []fakeMail
	err   error
}

func (m *fakeMailer) send(_ context.Context, to, subject, body string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sends = append(m.sends, fakeMail{to, subject, body})
	return m.err
}

// inviteFixture wires the manager webhook (top) and the invite-request API
// (behind the real router, base host "localhost") against a recording Telegram
// and a recording mailer. adminChat 0 / mail nil leave the feature off.
type inviteFixture struct {
	store  *cloudstore.Repo
	tg     *recordingTG
	top    http.Handler
	router http.Handler
	secret string
	api    *TelegramAPI
	mail   *fakeMailer
}

func newInviteFixture(t *testing.T, adminChat int64, ttl time.Duration, withMail bool) *inviteFixture {
	t.Helper()
	store := setupStore(t)
	tg := newRecordingTG(t)
	api := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", ttl)
	api.SetFeedbackAdminChat(adminChat)
	f := &inviteFixture{store: store, tg: tg, api: api, secret: deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")}
	top := http.NewServeMux()
	api.RegisterWebhookRoutes(top)
	f.top = top
	reqs := NewInviteRequestAPI(store, tgTestSecret)
	if withMail {
		f.mail = &fakeMailer{}
		api.mailer = f.mail
		reqs.Enable(api)
	}
	mux := http.NewServeMux()
	reqs.RegisterRoutes(mux)
	f.router = New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	return f
}

func (f *inviteFixture) post(t *testing.T, host, ip, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, inviteRequestsPath, strings.NewReader(body))
	r.Host = host
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-For", ip)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, r)
	f.api.inviteWork.Wait()
	return rec
}

// tap posts an Approve ("a") / Decline ("d") from user `from`, on message msgID.
func (f *inviteFixture) tap(t *testing.T, id int64, verb string, from, msgID int64) {
	t.Helper()
	body := fmt.Sprintf(`{"update_id":50,"callback_query":{"id":"cbq-ir","data":"ir:%d:%s","from":{"id":%d,"is_bot":false},`+
		`"message":{"message_id":%d,"text":"📨 Invite request","chat":{"id":%d,"type":"private"}}}}`, id, verb, from, msgID, inviteAdmin)
	postManager(t, f.top, f.secret, body)
	f.api.inviteWork.Wait()
}

func (f *inviteFixture) request(t *testing.T, id int64) *cloudstore.InviteRequest {
	t.Helper()
	req, err := f.store.InviteRequestByID(t.Context(), id)
	if err != nil {
		t.Fatalf("InviteRequestByID(%d): %v", id, err)
	}
	return req
}

func (f *inviteFixture) snapshot() (sent, edits, answered []string) {
	f.tg.mu.Lock()
	defer f.tg.mu.Unlock()
	return append([]string(nil), f.tg.mu.sent...), append([]string(nil), f.tg.mu.edits...), append([]string(nil), f.tg.mu.answered...)
}

func (f *inviteFixture) mails() []fakeMail {
	f.mail.mu.Lock()
	defer f.mail.mu.Unlock()
	return append([]fakeMail(nil), f.mail.sends...)
}

func adminPings(sent []string) int {
	n := 0
	for _, s := range sent {
		if strings.Contains(s, `"chat_id":555`) && strings.Contains(s, `"callback_data":"ir:`) {
			n++
		}
	}
	return n
}

func TestInviteRequest_EmailApprove(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	rec := f.post(t, "localhost", "203.0.113.1", `{"email":"  Ada@Example.COM ","note":"from the meetup"}`)
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"sent"`) {
		t.Fatalf("POST = %d %s, want 202", rec.Code, rec.Body.String())
	}
	req := f.request(t, 1)
	if req.Channel != "email" || req.EmailLC != "ada@example.com" || req.Note != "from the meetup" || req.Status != "pending" || req.AdminMessageID == 0 {
		t.Fatalf("row = %+v", req)
	}
	sent, _, _ := f.snapshot()
	if len(sent) != 1 || adminPings(sent) != 1 || !strings.Contains(sent[0], `ir:1:a`) || !strings.Contains(sent[0], `ir:1:d`) ||
		!strings.Contains(sent[0], "ada@example.com") || !strings.Contains(sent[0], "from the meetup") {
		t.Fatalf("admin ping = %v", sent)
	}

	f.tap(t, 1, "a", inviteAdmin, req.AdminMessageID)
	if n := mintedBy(t, f.store, "req:1"); n != 1 {
		t.Fatalf("minted %d accounts for req:1, want 1", n)
	}
	accounts, _ := f.store.ListAccounts(t.Context())
	mails := f.mails()
	want := "https://" + accounts[0].Subdomain + ".localhost/#claim="
	if len(mails) != 1 || mails[0].to != "ada@example.com" || !strings.Contains(mails[0].body, want) || !strings.Contains(mails[0].body, "expires in 14 days") {
		t.Fatalf("mails = %+v, want one to ada@example.com carrying %s", mails, want)
	}
	_, edits, answered := f.snapshot()
	if len(edits) != 1 || !strings.Contains(edits[0], "invite emailed to ada@example.com") || !strings.Contains(edits[0], `"inline_keyboard":[]`) || strings.Contains(edits[0], "#claim=") {
		t.Fatalf("admin edit = %v", edits)
	}
	if len(answered) != 1 || !strings.Contains(answered[0], "Approved") {
		t.Fatalf("answers = %v", answered)
	}
	if f.request(t, 1).Status != "approved" {
		t.Fatal("row not approved")
	}

	// A second tap (or a Telegram redelivery) decides nothing again.
	for _, verb := range []string{"a", "d"} {
		f.tap(t, 1, verb, inviteAdmin, req.AdminMessageID)
	}
	if n := mintedBy(t, f.store, "req:1"); n != 1 || len(f.mails()) != 1 {
		t.Fatalf("second tap minted/sent again: minted=%d mails=%d", n, len(f.mails()))
	}
	_, _, answered = f.snapshot()
	if len(answered) != 3 || !strings.Contains(answered[2], "Already decided") {
		t.Fatalf("answers = %v", answered)
	}
}

func TestInviteRequest_EmailDecline(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`)
	f.tap(t, 1, "d", inviteAdmin, f.request(t, 1).AdminMessageID)
	if len(f.mails()) != 0 || mintedBy(t, f.store, "req:1") != 0 {
		t.Fatal("decline sent mail or minted")
	}
	_, edits, _ := f.snapshot()
	if f.request(t, 1).Status != "declined" || len(edits) != 1 || !strings.Contains(edits[0], "Declined") {
		t.Fatalf("status/edit after decline: %s %v", f.request(t, 1).Status, edits)
	}
}

func TestInviteRequest_CallbackGuards(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`)
	msgID := f.request(t, 1).AdminMessageID

	f.tap(t, 1, "a", 4242, msgID)      // not the admin
	f.tap(t, 1, "a", inviteAdmin, 999) // the admin, but another message
	postManager(t, f.top, f.secret, `{"update_id":51,"callback_query":{"id":"x","data":"ir:1:zz","from":{"id":555}}}`)
	postManager(t, f.top, f.secret, `{"update_id":52,"callback_query":{"id":"y","data":"ir:77:a","from":{"id":555},"message":{"message_id":1,"chat":{"id":555,"type":"private"}}}}`)
	f.api.inviteWork.Wait()

	if f.request(t, 1).Status != "pending" || mintedBy(t, f.store, "req:1") != 0 || len(f.mails()) != 0 {
		t.Fatal("a guarded tap changed state")
	}
	_, edits, answered := f.snapshot()
	if len(answered) != 4 || len(edits) != 0 {
		t.Fatalf("every tap must be acked, none acted on: answered=%v edits=%v", answered, edits)
	}
}

// A pending email row outliving its SMTP config (codex review): Approve is
// refused before any mint, the row stays pending, and nothing panics.
func TestInviteRequest_EmailApproveWithoutSMTP(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`)
	f.api.mailer = nil // the restart without SMTP
	f.tap(t, 1, "a", inviteAdmin, f.request(t, 1).AdminMessageID)
	if f.request(t, 1).Status != "pending" || mintedBy(t, f.store, "req:1") != 0 || len(f.mails()) != 0 {
		t.Fatal("approve without SMTP minted or decided")
	}
	_, edits, answered := f.snapshot()
	if len(edits) != 0 || len(answered) != 1 || !strings.Contains(answered[0], "fix SMTP") {
		t.Fatalf("answers=%v edits=%v", answered, edits)
	}
	// Decline still works without mail.
	f.tap(t, 1, "d", inviteAdmin, f.request(t, 1).AdminMessageID)
	if f.request(t, 1).Status != "declined" {
		t.Fatal("decline without SMTP did not decide")
	}
}

func TestInviteRequest_SendFailureShowsLink(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	f.mail.err = errors.New("dial tcp: connection refused")
	f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`)
	f.tap(t, 1, "a", inviteAdmin, f.request(t, 1).AdminMessageID)
	accounts, _ := f.store.ListAccounts(t.Context())
	_, edits, _ := f.snapshot()
	if f.request(t, 1).Status != "approved" || len(edits) != 1 || !strings.Contains(edits[0], "FAILED") ||
		!strings.Contains(edits[0], "https://"+accounts[0].Subdomain+".localhost/#claim=") || strings.Contains(edits[0], "refused") {
		t.Fatalf("failure edit = %v", edits)
	}
}

func TestInviteRequest_Validation(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	for i, body := range []string{
		`{"email":"Ada <ada@example.com>"}`,
		`{"email":"<ada@example.com>"}`,
		`{"email":"ada@example.com\r\nBcc: x@example.com"}`,
		`{"email":"ada@example.com\nx"}`,
		`{"email":"nope"}`,
		`{"email":"ada@localhost"}`,
		`{"email":""}`,
		`{"email":"ada@example.com","note":"` + strings.Repeat("é", 501) + `"}`,
		`not json`,
	} {
		if rec := f.post(t, "localhost", "198.51.100."+strconv.Itoa(i), body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, want 400", body, rec.Code)
		}
	}
	if rec := f.post(t, "localhost", "198.51.100.99", `{"email":"ada@example.com","note":"`+strings.Repeat("é", 500)+`"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("500-rune note → %d, want 202", rec.Code)
	}
}

func TestInviteRequest_LimitsAndDedupe(t *testing.T) {
	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	// Dupe within 7 days: same answer, one row, one ping.
	f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`)
	if rec := f.post(t, "localhost", "203.0.113.2", `{"email":"ADA@example.com"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("dupe → %d, want 202", rec.Code)
	}
	if sent, _, _ := f.snapshot(); adminPings(sent) != 1 {
		t.Fatalf("dupe pinged again: %v", sent)
	}
	if _, err := f.store.InviteRequestByID(t.Context(), 2); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("dupe inserted a row: %v", err)
	}

	// Per IP: 5 an hour.
	for i := 0; i < inviteRequestIPMax; i++ {
		f.post(t, "localhost", "192.0.2.9", fmt.Sprintf(`{"email":"p%d@example.com"}`, i))
	}
	if rec := f.post(t, "localhost", "192.0.2.9", `{"email":"p9@example.com"}`); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("6th from one IP → %d, want 429", rec.Code)
	}

	// Global: 50 a day, persisted.
	now := time.Now().UTC()
	for i := 0; i < inviteRequestDailyCap; i++ {
		if _, _, err := f.store.CreateEmailInviteRequest(t.Context(), fmt.Sprintf("g%d@example.com", i), "", "", now, inviteRequestDedupe, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if rec := f.post(t, "localhost", "192.0.2.10", `{"email":"late@example.com"}`); rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "busy") {
		t.Fatalf("over the daily cap → %d %s, want 429 busy", rec.Code, rec.Body.String())
	}
}

func TestInviteRequest_DisabledAndRouting(t *testing.T) {
	for name, f := range map[string]*inviteFixture{
		"no mailer":     newInviteFixture(t, inviteAdmin, 14*24*time.Hour, false),
		"no admin chat": newInviteFixture(t, 0, 14*24*time.Hour, false),
	} {
		if rec := f.post(t, "localhost", "203.0.113.1", `{"email":"ada@example.com"}`); rec.Code != http.StatusNotFound {
			t.Errorf("%s: POST → %d, want 404", name, rec.Code)
		}
	}

	f := newInviteFixture(t, inviteAdmin, 14*24*time.Hour, true)
	acc, _ := setupInvite(t, f.store)
	if rec := f.post(t, acc.Subdomain+".localhost", "203.0.113.1", `{"email":"ada@example.com"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("account host POST → %d, want 404 (base host only)", rec.Code)
	}

	r := httptest.NewRequest(http.MethodOptions, inviteRequestsPath, nil)
	r.Host = "localhost"
	r.Header.Set("Origin", localAppOrigin)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, r)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != localAppOrigin {
		t.Fatalf("preflight → %d ACAO=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
	r = httptest.NewRequest(http.MethodOptions, inviteRequestsPath, nil)
	r.Host = "localhost"
	r.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	f.router.ServeHTTP(rec, r)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("foreign origin got CORS")
	}
}

func TestInviteRequest_Sweep(t *testing.T) {
	store := setupStore(t)
	old := time.Now().UTC().Add(-91 * 24 * time.Hour)
	if _, _, err := store.CreateEmailInviteRequest(t.Context(), "old@example.com", "", "", old, inviteRequestDedupe, 50); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.CreateTGInviteRequest(t.Context(), 77, 4242, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InviteRequestByID(t.Context(), 1); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("90-day-old row survived the sweep: %v", err)
	}
}
