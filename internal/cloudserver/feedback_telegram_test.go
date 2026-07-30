package cloudserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

func TestEncryptFeedbackDoc_RoundTrip(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	plaintext := []byte(`{"v":1,"created_at":"2026-07-19T00:00:00Z","text":"hi dev","attachments":[]}`)

	ct, err := encryptFeedbackDoc(id.Recipient().String(), plaintext)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if bytes.Contains(ct, []byte("hi dev")) {
		t.Fatal("ciphertext leaks plaintext")
	}

	r, err := age.Decrypt(bytes.NewReader(ct), id)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("round-trip mismatch: got %s", got)
	}
}

func TestEncryptFeedbackDoc_EmptyRecipient(t *testing.T) {
	if _, err := encryptFeedbackDoc("", []byte("x")); err == nil {
		t.Fatal("expected error for empty recipient")
	}
}

func TestFeedbackWaiting_SetTakeOnce(t *testing.T) {
	tg := &TelegramAPI{feedbackWaiting: make(map[int64]time.Time)}
	tg.setFeedbackWaiting(42)
	if !tg.takeFeedbackWaiting(42) {
		t.Fatal("first take should be true")
	}
	if tg.takeFeedbackWaiting(42) {
		t.Fatal("second take should be false (cleared)")
	}
	if tg.takeFeedbackWaiting(99) {
		t.Fatal("unknown chat should be false")
	}
}

func TestFeedbackWaiting_Expired(t *testing.T) {
	tg := &TelegramAPI{feedbackWaiting: make(map[int64]time.Time)}
	tg.feedbackWaiting[7] = time.Now().Add(-time.Minute) // already expired
	if tg.takeFeedbackWaiting(7) {
		t.Fatal("expired entry should return false")
	}
}

// managerFeedbackFixture wires the manager webhook with the Telegram feedback
// channel enabled (a fresh age recipient), returning the decrypt identity so a
// test can verify a queued blob round-trips. adminChatID 0 leaves the admin
// relay off (the default deployment).
func managerFeedbackFixture(t *testing.T, adminChatID int64) (*cloudstore.Repo, *recordingTG, http.Handler, string, *age.X25519Identity) {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	store := setupStore(t)
	tg := newRecordingTG(t)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, id.Recipient().String(), 14*24*time.Hour)
	tgAPI.SetFeedbackAdminChat(adminChatID)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	return store, tg, top, deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1"), id
}

// seedClaimedAccount inserts a claimed account attributed to creator so a manager
// message from that Telegram user resolves to a real account id.
func seedClaimedAccount(t *testing.T, store *cloudstore.Repo, creator string) string {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	tokenHash := []byte("claim-hash-fb-account-0000000000")
	acc, err := store.CreateAccount(ctx, "acc-fb", "brave-otter-fb1234", tokenHash, now.Add(time.Hour), now, "", "", creator)
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if _, err := store.ConsumeClaimToken(ctx, acc.Subdomain, tokenHash, now); err != nil {
		t.Fatalf("ConsumeClaimToken: %v", err)
	}
	return acc.ID
}

// postManager posts a raw manager update and asserts a 200.
func postManager(t *testing.T, h http.Handler, secret, body string) {
	t.Helper()
	rec := postWebhook(t, h, "/tg/manager/"+secret, secret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("manager update status = %d, want 200; body=%s", rec.Code, body)
	}
}

// fbCallbackBody is a "Send feedback" tap from user 4242 in private chat 77.
const fbCallbackBody = `{"update_id":9,"callback_query":{"id":"cbq1","data":"fb","from":{"id":4242,"is_bot":false},"message":{"message_id":5,"chat":{"id":77,"type":"private"}}}}`

// resetSent clears the recording TG's sent log between phases of a test.
func resetSent(tg *recordingTG) {
	tg.mu.Lock()
	tg.mu.sent = nil
	tg.mu.answered = nil
	tg.mu.Unlock()
}

// onlyFeedbackDoc drains the single queued item and decrypts it to a doc.
func onlyFeedbackDoc(t *testing.T, store *cloudstore.Repo, id *age.X25519Identity) (cloudstore.FeedbackItem, feedbackDoc) {
	t.Helper()
	items, err := store.ListFeedback(context.Background(), 100)
	if err != nil {
		t.Fatalf("ListFeedback: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("want exactly 1 queued item, got %d", len(items))
	}
	r, err := age.Decrypt(bytes.NewReader(items[0].Ciphertext), id)
	if err != nil {
		t.Fatalf("decrypt queued item: %v", err)
	}
	plaintext, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read plaintext: %v", err)
	}
	var doc feedbackDoc
	if err := json.Unmarshal(plaintext, &doc); err != nil {
		t.Fatalf("unmarshal doc: %v (%s)", err, plaintext)
	}
	return items[0], doc
}

func TestManagerFeedback_ButtonOnlyForLinkedSender(t *testing.T) {
	t.Run("linked greeting carries the fb button", func(t *testing.T) {
		store, tg, top, secret, _ := managerFeedbackFixture(t, 0)
		seedClaimedAccount(t, store, tgCreator)
		tgMessage(t, top, secret, "hi")
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], `"callback_data":"fb"`) {
			t.Fatalf("linked greeting missing feedback button: %v", tg.mu.sent)
		}
	})

	t.Run("unlinked greeting has no button", func(t *testing.T) {
		_, tg, top, secret, _ := managerFeedbackFixture(t, 0)
		tgMessage(t, top, secret, "hi")
		if len(tg.mu.sent) != 1 || strings.Contains(tg.mu.sent[0], "callback_data") {
			t.Fatalf("unlinked greeting should carry no button: %v", tg.mu.sent)
		}
	})

	t.Run("disabled channel never offers the button", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t) // recipient ""
		seedClaimedAccount(t, store, tgCreator)
		tgMessage(t, top, secret, "hi")
		if len(tg.mu.sent) != 1 || strings.Contains(tg.mu.sent[0], "callback_data") {
			t.Fatalf("disabled channel offered a button: %v", tg.mu.sent)
		}
	})
}

func TestManagerFeedback_CallbackArmsCapture(t *testing.T) {
	_, tg, top, secret, _ := managerFeedbackFixture(t, 0)
	postManager(t, top, secret, fbCallbackBody)
	if len(tg.mu.answered) != 1 {
		t.Fatalf("callback tap not acked: %v", tg.mu.answered)
	}
	if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "Send your message") {
		t.Fatalf("no capture prompt after tap: %v", tg.mu.sent)
	}
}

func TestManagerFeedback_CaptureText(t *testing.T) {
	store, tg, top, secret, id := managerFeedbackFixture(t, 0)
	accountID := seedClaimedAccount(t, store, tgCreator)

	postManager(t, top, secret, fbCallbackBody) // arm chat 77
	resetSent(tg)
	tgMessage(t, top, secret, "the weight chart is broken")

	if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "Thanks") {
		t.Fatalf("no thanks reply after feedback: %v", tg.mu.sent)
	}
	item, doc := onlyFeedbackDoc(t, store, id)
	if item.AccountID != accountID || item.Kind != "telegram" {
		t.Fatalf("queued item mis-scoped: account=%q kind=%q, want %q telegram", item.AccountID, item.Kind, accountID)
	}
	if doc.V != 1 || doc.Text != "the weight chart is broken" {
		t.Fatalf("decrypted doc mismatch: %+v", doc)
	}

	// The armed flag is single-use: a follow-up message is ordinary again.
	resetSent(tg)
	tgMessage(t, top, secret, "hi")
	if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], `"callback_data":"fb"`) {
		t.Fatalf("follow-up message was still captured or lost its greeting: %v", tg.mu.sent)
	}
	if items, _ := store.ListFeedback(context.Background(), 100); len(items) != 1 {
		t.Fatalf("follow-up greeting queued extra feedback: %d items", len(items))
	}
}

func TestManagerFeedback_CapturePhotoWithCaption(t *testing.T) {
	store, tg, top, secret, id := managerFeedbackFixture(t, 0)
	seedClaimedAccount(t, store, tgCreator)

	postManager(t, top, secret, fbCallbackBody)
	resetSent(tg)
	postManager(t, top, secret, `{"update_id":9,"message":{"message_id":1,"caption":"see the glitch","photo":[{"file_id":"AgACPHOTO","file_size":8}],"from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`)

	_, doc := onlyFeedbackDoc(t, store, id)
	if doc.Text != "see the glitch" {
		t.Fatalf("caption not used as text: %+v", doc)
	}
	if len(doc.Attachments) != 1 || doc.Attachments[0].Type != "image" {
		t.Fatalf("photo attachment missing: %+v", doc.Attachments)
	}
	want := base64.StdEncoding.EncodeToString([]byte(fakePhotoBytes))
	if doc.Attachments[0].DataB64 != want {
		t.Fatalf("attachment bytes mismatch: got %q want %q", doc.Attachments[0].DataB64, want)
	}
}

func TestManagerFeedback_CaptureVoice(t *testing.T) {
	store, tg, top, secret, id := managerFeedbackFixture(t, 0)
	seedClaimedAccount(t, store, tgCreator)

	postManager(t, top, secret, fbCallbackBody)
	resetSent(tg)
	postManager(t, top, secret, `{"update_id":9,"message":{"message_id":1,"voice":{"file_id":"VOICE1","mime_type":"audio/ogg","duration":3,"file_size":8},"from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`)

	_, doc := onlyFeedbackDoc(t, store, id)
	if len(doc.Attachments) != 1 || doc.Attachments[0].Type != "audio" || doc.Attachments[0].Mime != "audio/ogg" {
		t.Fatalf("voice attachment missing/mistyped: %+v", doc.Attachments)
	}
}

func TestManagerFeedback_CaptureRejectedWithoutAccount(t *testing.T) {
	store, tg, top, secret, _ := managerFeedbackFixture(t, 0)
	// No claimed account for tg:4242 — a stale tap arrives.
	postManager(t, top, secret, fbCallbackBody)
	resetSent(tg)
	tgMessage(t, top, secret, "here is my feedback")

	if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "Finish setting up your account") {
		t.Fatalf("unlinked capture not rejected: %v", tg.mu.sent)
	}
	if items, _ := store.ListFeedback(context.Background(), 100); len(items) != 0 {
		t.Fatalf("unlinked sender queued feedback: %d items", len(items))
	}
}

// feedbackAdminChat stands in for FEEDBACK_ADMIN_CHAT_ID in relay tests.
const feedbackAdminChat = int64(9001)

// waitForSent polls the fake for at least n recorded sendMessage bodies. The
// web ping is fired on its own goroutine, so the assertion can't be immediate.
func waitForSent(t *testing.T, tg *recordingTG, n int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		tg.mu.Lock()
		sent := append([]string(nil), tg.mu.sent...)
		tg.mu.Unlock()
		if len(sent) >= n {
			return sent
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d sent message(s), got %d: %v", n, len(sent), sent)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestNotifyFeedback_NoopWhenAdminChatUnset: the default deployment
// (FEEDBACK_ADMIN_CHAT_ID unset) sends nothing at all.
func TestNotifyFeedback_NoopWhenAdminChatUnset(t *testing.T) {
	tg := newRecordingTG(t)
	tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", time.Hour)
	tgAPI.NotifyFeedback("bug", "1.2.3") // synchronous — nothing can be in flight
	if len(tg.mu.sent) != 0 {
		t.Fatalf("relay fired with no admin chat configured: %v", tg.mu.sent)
	}
}

// TestNotifyFeedback_TruncatesUntrustedMetadata: kind/app_version come straight
// off a POST body, so they are capped before they reach a Telegram message.
func TestNotifyFeedback_TruncatesUntrustedMetadata(t *testing.T) {
	tg := newRecordingTG(t)
	tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", time.Hour)
	tgAPI.SetFeedbackAdminChat(feedbackAdminChat)
	tgAPI.NotifyFeedback(strings.Repeat("A", 5000), "")

	if len(tg.mu.sent) != 1 {
		t.Fatalf("want 1 ping, got %v", tg.mu.sent)
	}
	if strings.Contains(tg.mu.sent[0], strings.Repeat("A", feedbackPingFieldMax+1)) {
		t.Fatalf("oversized kind was not truncated: %s", tg.mu.sent[0])
	}
	if !strings.Contains(tg.mu.sent[0], "app —") {
		t.Fatalf("empty app version should render as a placeholder: %s", tg.mu.sent[0])
	}
}

// TestManagerFeedback_RelaysFullContentToAdmin: telegram-origin feedback is
// relayed in full — the manager bot already held that plaintext — as a header
// plus a copyMessage of the user's own message, so media rides along by file_id.
func TestManagerFeedback_RelaysFullContentToAdmin(t *testing.T) {
	cases := map[string]string{
		"text":  `{"update_id":9,"message":{"message_id":11,"text":"the weight chart is broken","from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`,
		"voice": `{"update_id":9,"message":{"message_id":12,"voice":{"file_id":"VOICE1","mime_type":"audio/ogg","duration":3,"file_size":8},"from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`,
		"photo": `{"update_id":9,"message":{"message_id":13,"caption":"see the glitch","photo":[{"file_id":"AgACPHOTO","file_size":8}],"from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`,
	}
	for name, update := range cases {
		t.Run(name, func(t *testing.T) {
			store, tg, top, secret, _ := managerFeedbackFixture(t, feedbackAdminChat)
			seedClaimedAccount(t, store, tgCreator)
			postManager(t, top, secret, fbCallbackBody)
			resetSent(tg)
			postManager(t, top, secret, update)

			// One thanks to the user (chat 77), one header to the admin (9001).
			if len(tg.mu.sent) != 2 {
				t.Fatalf("want thanks + admin header, got %v", tg.mu.sent)
			}
			if !strings.Contains(tg.mu.sent[0], "Thanks") {
				t.Fatalf("user lost their thanks reply: %v", tg.mu.sent)
			}
			if !strings.Contains(tg.mu.sent[1], `"chat_id":9001`) || !strings.Contains(tg.mu.sent[1], "New feedback (telegram)") {
				t.Fatalf("admin header missing/mis-addressed: %v", tg.mu.sent)
			}
			if len(tg.mu.copies) != 1 {
				t.Fatalf("want exactly 1 copyMessage to the admin, got %v", tg.mu.copies)
			}
			for _, want := range []string{`"chat_id":9001`, `"from_chat_id":77`} {
				if !strings.Contains(tg.mu.copies[0], want) {
					t.Errorf("copyMessage missing %q: %s", want, tg.mu.copies[0])
				}
			}
			if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 1 {
				t.Fatalf("relay changed what was queued: %d items", len(items))
			}
		})
	}
}

// TestManagerFeedback_AdminRelayFailureIsInvisibleToTheUser: Telegram refuses
// every send — the feedback is still queued and the user still gets a reply.
func TestManagerFeedback_AdminRelayFailureIsInvisibleToTheUser(t *testing.T) {
	store, tg, top, secret, _ := managerFeedbackFixture(t, feedbackAdminChat)
	seedClaimedAccount(t, store, tgCreator)
	postManager(t, top, secret, fbCallbackBody)
	resetSent(tg)
	tg.mu.Lock()
	tg.mu.sendFails = true
	tg.mu.Unlock()

	tgMessage(t, top, secret, "the weight chart is broken")

	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 1 {
		t.Fatalf("a failing admin relay lost the feedback: %d items", len(items))
	}
}

func TestManagerFeedback_CallbackIgnoredWhenDisabled(t *testing.T) {
	_, tg, top, secret := managerFixture(t) // recipient ""
	postManager(t, top, secret, fbCallbackBody)
	// The tap is still acked (button stops spinning) but no prompt is sent.
	if len(tg.mu.answered) != 1 {
		t.Fatalf("callback not acked when disabled: %v", tg.mu.answered)
	}
	if len(tg.mu.sent) != 0 {
		t.Fatalf("disabled channel sent a prompt: %v", tg.mu.sent)
	}
}
