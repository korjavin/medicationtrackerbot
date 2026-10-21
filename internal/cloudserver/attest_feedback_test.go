package cloudserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

const attestFeedbackRecipient = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq"

// feedbackBody is the session route's body shape; ciphertext is base64.
func feedbackBody(clientID string) string {
	return `{"client_id":"` + clientID + `","kind":"bug","app_version":"1.2.3","ciphertext":"YWdlLWJsb2I="}`
}

// Local-mode feedback (bd med-ta2n.19): attested, queued under
// 'attest:<key id>', recipient discovered from the challenge JSON.
func TestAttestFeedback(t *testing.T) {
	e := newAttestEnv(t, 3, 0, 0)
	ctx := context.Background()

	// No SetFeedback: the challenge carries an empty recipient, the route 503s.
	rec := e.do("localhost", attestChallengePath, "", nil)
	var ch struct {
		Recipient *string `json:"feedback_recipient"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &ch) != nil || ch.Recipient == nil || *ch.Recipient != "" {
		t.Fatalf("challenge without feedback: %s", rec.Body.String())
	}
	k := attestKey(t)
	if rec := e.enroll(k, attestTestAppID, e.challenge(), "tok"); rec.Code != http.StatusOK {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	wantErr(t, e.chatAt(k, 1, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("c0"), feedbackBody("c0")), http.StatusServiceUnavailable, "feedback_disabled")

	// A FeedbackAPI with an empty recipient is still "off".
	e.attest.SetFeedback(NewFeedbackAPI(e.store, "s", ""))
	wantErr(t, e.chatAt(k, 1, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("c0"), feedbackBody("c0")), http.StatusServiceUnavailable, "feedback_disabled")

	fb := NewFeedbackAPI(e.store, "s", attestFeedbackRecipient)
	pings := make(chan [2]string, 4)
	fb.SetNotifier(func(kind, appVersion string) { pings <- [2]string{kind, appVersion} })
	e.attest.SetFeedback(fb)
	rec = e.do("localhost", attestChallengePath, "", nil)
	if json.Unmarshal(rec.Body.Bytes(), &ch) != nil || ch.Recipient == nil || *ch.Recipient != attestFeedbackRecipient {
		t.Fatalf("challenge recipient: %s", rec.Body.String())
	}

	post := func(counter uint32, body, signed string) *httptest.ResponseRecorder {
		return e.chatAt(k, counter, e.challenge(), attestFeedbackPath, attestFeedbackPath, body, signed)
	}
	rec = post(1, feedbackBody("c1"), feedbackBody("c1"))
	if rec.Code != http.StatusNoContent || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("submit: %d %s", rec.Code, rec.Body.String())
	}
	waitPing := func() {
		t.Helper()
		select {
		case p := <-pings:
			if p != [2]string{"bug", "1.2.3"} {
				t.Fatalf("ping: %v", p)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no admin ping")
		}
	}
	waitPing()
	items, err := e.store.ListFeedback(ctx, 10)
	if err != nil || len(items) != 1 || items[0].AccountID != "attest:"+attestKeyID(t, k) || items[0].ClientID != "c1" || string(items[0].Ciphertext) != "age-blob" {
		t.Fatalf("queued: %+v %v", items, err)
	}
	// A retry of the same client_id: 204, no new row, no ping.
	if rec := post(2, feedbackBody("c1"), feedbackBody("c1")); rec.Code != http.StatusNoContent {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	// Reused counter, forged body, unknown key: 401.
	wantErr(t, post(2, feedbackBody("c2"), feedbackBody("c2")), http.StatusUnauthorized, "assertion_invalid")
	wantErr(t, post(3, feedbackBody("c2"), feedbackBody("c3")), http.StatusUnauthorized, "assertion_invalid")
	wantErr(t, e.chatAt(attestKey(t), 1, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("c2"), feedbackBody("c2")), http.StatusUnauthorized, "install_unknown")
	// A replayed challenge never reaches the assertion check.
	chal := e.challenge()
	if rec := e.chatAt(k, 4, chal, attestFeedbackPath, attestFeedbackPath, feedbackBody("c4"), feedbackBody("c4")); rec.Code != http.StatusNoContent {
		t.Fatalf("c4: %d %s", rec.Code, rec.Body.String())
	}
	waitPing()
	wantErr(t, e.chatAt(k, 5, chal, attestFeedbackPath, attestFeedbackPath, feedbackBody("c5"), feedbackBody("c5")), http.StatusBadRequest, "challenge_invalid")
	// Signed but malformed: 400.
	wantErr(t, post(6, `{"client_id":"","ciphertext":"YQ=="}`, `{"client_id":"","ciphertext":"YQ=="}`), http.StatusBadRequest, "invalid_request")

	// Over the per-install cap (c1 + c4 + 98 = 100 rows): 429.
	for i := 0; i < 98; i++ {
		if _, err := e.store.AppendFeedback(ctx, cloudstore.AttestFeedbackAccount(attestKeyID(t, k)), "fill-"+strconv.Itoa(i), "", "", []byte{1}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	wantErr(t, post(7, feedbackBody("c7"), feedbackBody("c7")), http.StatusTooManyRequests, "feedback_queue_full")
	if len(pings) != 0 { // the retry, rejects and cap sent none
		t.Fatalf("extra pings: %d", len(pings))
	}
}
