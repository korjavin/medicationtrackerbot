package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// enrollReply is the enroll answer's fields the feedback-only tests read.
type enrollReply struct {
	Remaining int    `json:"remaining"`
	Granted   *bool  `json:"granted"`
	Pass      string `json:"pass"`
}

func readEnroll(t *testing.T, rec *httptest.ResponseRecorder) enrollReply {
	t.Helper()
	var out enrollReply
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Granted == nil {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	return out
}

// enrollIOS is enrollPass with extra body fields (e.g. "trial": false); a
// token "" sends no device_token.
func (e *attestEnv) enrollIOS(k *ecdsa.PrivateKey, token string, extra map[string]any) *httptest.ResponseRecorder {
	chal := e.challenge()
	raw, _ := base64.StdEncoding.DecodeString(chal)
	req := map[string]any{
		"key_id": attestKeyID(e.t, k), "challenge": chal,
		"attestation": base64.StdEncoding.EncodeToString(fakeAttestation(e.t, e.ca, k, attestTestAppID, raw)),
	}
	if token != "" {
		req["device_token"] = token
	}
	for f, v := range extra {
		req[f] = v
	}
	body, _ := json.Marshal(req)
	return e.do("localhost", attestEnrollPath, string(body), nil)
}

var feedbackOnly = map[string]any{"trial": false}

// bd med-ta2n.25: enroll {trial:false} keys an install for feedback without a
// trial grant — no DeviceCheck, no pass — and the budgeted routes refuse it
// until the same key enrolls again with a device token.
func TestAttestFeedbackOnlyEnroll(t *testing.T) {
	ctx := context.Background()
	e := newAttestEnv(t, 3, 0, 0)
	e.voiceOn()
	e.attest.SetFeedback(NewFeedbackAPI(e.store, "s", attestFeedbackRecipient))
	k := attestKey(t)
	keyID := attestKeyID(t, k)

	// No device token, a pass that is ignored: 200 granted:false, no DeviceCheck.
	rec := e.enrollIOS(k, "", map[string]any{"trial": false, "pass": "bogus.pass"})
	got := readEnroll(t, rec)
	if _, calls := e.dc.state(""); *got.Granted || got.Remaining != 0 || got.Pass != "" || calls != 0 ||
		rec.Header().Get("X-Attest-Challenge") == "" || rec.Header().Get("X-Trial-Remaining") != "0" {
		t.Fatalf("feedback-only enroll: %s dc calls %d", rec.Body.String(), calls)
	}
	if h, err := e.store.AttestBucketPassHash(ctx, keyID); err != nil || h != nil {
		t.Fatalf("feedback-only bucket has a pass: %x %v", h, err)
	}
	// Re-enroll trial:false: as stored.
	if got := readEnroll(t, e.enrollIOS(k, "tok-U", feedbackOnly)); *got.Granted {
		t.Fatal("re-enroll granted")
	}
	if _, calls := e.dc.state(""); calls != 0 {
		t.Fatalf("re-enroll called DeviceCheck %d times", calls)
	}

	// Feedback: 204, queued under the bucket.
	if rec := e.chatAt(k, 1, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("f1"), feedbackBody("f1")); rec.Code != http.StatusNoContent {
		t.Fatalf("feedback: %d %s", rec.Code, rec.Body.String())
	}
	if items, err := e.store.ListFeedback(ctx, 10); err != nil || len(items) != 1 || items[0].AccountID != "attest:"+keyID {
		t.Fatalf("queued: %+v %v", items, err)
	}
	// Chat, food, voice: 403 trial_not_granted, nothing consumed or called.
	wantErr(t, e.chat(k, 2, e.challenge(), attestChatBody, attestChatBody), http.StatusForbidden, "trial_not_granted")
	bc := attestFoodBarcode + "4006381333931"
	wantErr(t, e.foodGet("localhost", k, 3, e.challenge(), bc, bc), http.StatusForbidden, "trial_not_granted")
	wantErr(t, mustRec(e.voiceStart(k, 4)), http.StatusForbidden, "trial_not_granted")
	if e.upHits.Load() != 0 || e.foodHits.Load() != 0 || e.mintCalls.Load() != 0 || e.voiceUsed(k) != 0 {
		t.Fatalf("upstream reached: ai %d food %d mint %d", e.upHits.Load(), e.foodHits.Load(), e.mintCalls.Load())
	}
	if in, err := e.store.AttestInstall(ctx, keyID); err != nil || in.Used != 0 || in.Counter != 1 {
		t.Fatalf("refused routes moved the install: %+v %v", in, err)
	}

	// Upgrade: the same key with a device token (trial absent) runs the gate
	// once (query + bit write), gets a pass, then chats.
	got = readEnroll(t, e.enrollIOS(k, "tok-U", nil))
	bits, calls := e.dc.state("tok-U")
	if !*got.Granted || got.Pass == "" || got.Remaining != 3 || bits != [2]bool{true, false} || calls != 2 {
		t.Fatalf("upgrade: %+v bits %v calls %d", got, bits, calls)
	}
	pass := got.Pass
	if rec := e.chat(k, 5, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK || rec.Header().Get("X-Trial-Remaining") != "2" {
		t.Fatalf("chat after upgrade: %d %s", rec.Code, rec.Body.String())
	}
	// Granted now: a later trial:false enroll keeps it.
	if got := readEnroll(t, e.enrollIOS(k, "", feedbackOnly)); !*got.Granted || got.Remaining != 2 {
		t.Fatalf("granted key re-enrolled feedback-only: %+v", got)
	}

	// A device whose bits are both set: the upgrade is refused, the key keeps
	// signing feedback, and its per-bucket cap still applies.
	e.dc.mu.Lock()
	e.dc.bits["tok-X"] = [2]bool{true, true}
	e.dc.mu.Unlock()
	k2 := attestKey(t)
	readEnroll(t, e.enrollIOS(k2, "tok-X", feedbackOnly))
	wantErr(t, e.enrollIOS(k2, "tok-X", nil), http.StatusForbidden, "trial_already_used")
	if in, err := e.store.AttestInstall(ctx, attestKeyID(t, k2)); err != nil || in.Granted {
		t.Fatalf("refused upgrade lost the row: %+v %v", in, err)
	}
	if rec := e.chatAt(k2, 1, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("f2"), feedbackBody("f2")); rec.Code != http.StatusNoContent {
		t.Fatalf("feedback after refused upgrade: %d %s", rec.Code, rec.Body.String())
	}
	for i := 0; i < 99; i++ {
		if _, err := e.store.AppendFeedback(ctx, cloudstore.AttestFeedbackAccount(attestKeyID(t, k2)), "fill-"+strconv.Itoa(i), "", "", []byte{1}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	wantErr(t, e.chatAt(k2, 2, e.challenge(), attestFeedbackPath, attestFeedbackPath, feedbackBody("f3"), feedbackBody("f3")), http.StatusTooManyRequests, "feedback_queue_full")

	// The bit write fails during an upgrade: 503 and the grant is revoked.
	k3 := attestKey(t)
	readEnroll(t, e.enrollIOS(k3, "", feedbackOnly))
	e.dc.mu.Lock()
	e.dc.failUpdate = true
	e.dc.mu.Unlock()
	wantErr(t, e.enrollIOS(k3, "tok-F", nil), http.StatusServiceUnavailable, "trial_unavailable")
	e.dc.mu.Lock()
	e.dc.failUpdate = false
	e.dc.mu.Unlock()
	if in, err := e.store.AttestInstall(ctx, attestKeyID(t, k3)); err != nil || in.Granted {
		t.Fatalf("grant kept after the bit write failed: %+v %v", in, err)
	}
	if h, _ := e.store.AttestBucketPassHash(ctx, attestKeyID(t, k3)); h != nil {
		t.Fatal("pass hash kept after rollback")
	}

	// A feedback-only key presenting a trial pass moves into that bucket, no
	// DeviceCheck call.
	_, before := e.dc.state("")
	got = readEnroll(t, e.enrollIOS(k3, "", map[string]any{"pass": pass}))
	if _, after := e.dc.state(""); !*got.Granted || got.Pass != "" || got.Remaining != 2 || after != before {
		t.Fatalf("pass upgrade: %+v dc %d→%d", got, before, after)
	}
	if in, _ := e.store.AttestInstall(ctx, attestKeyID(t, k3)); in.BucketID != keyID {
		t.Fatalf("moved bucket: %+v", in)
	}

	// trial:false needs no device token, but today's body still does.
	wantErr(t, e.enrollIOS(attestKey(t), "", nil), http.StatusBadRequest, "invalid_json")
}

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
