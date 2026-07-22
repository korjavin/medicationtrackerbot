package cloudserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
)

// relaySendTimeout bounds a single subscription's push-service round trip so
// one slow endpoint can't stall an entire tick.
const relaySendTimeout = 10 * time.Second

// maxMedRefireWindow caps how long past a dose slot the relay keeps re-firing an
// unconfirmed med reminder. Derived from the slot instant carried in the "s:"
// callback (no counter): once now - slot exceeds this, the relay stops chaining.
const maxMedRefireWindow = 6 * time.Hour

// Task 7's stale-sync sweep cadence and thresholds. The warning fires at most
// once a day per account (warnCooldown) once the account's scheduled-push
// queue is close to running dry (dryQueueWarnWithin, default 120h) and it
// hasn't synced in staleSyncAfter.
const (
	staleSweepInterval        = time.Hour
	staleSyncAfter            = 24 * time.Hour
	warnCooldown              = 24 * time.Hour
	defaultDryQueueWarnWithin = 120 * time.Hour
)

// staleSyncWarningPayload is the server-composed, content-free push body
// (Task 7): a literal constant, never derived from account data, sent
// outside the NK app-layer encryption path. web/cloud/sw.js recognizes
// kind=="server-warning" and renders it directly instead of attempting an NK
// decrypt.
var staleSyncWarningPayload = mustMarshalStaleSyncWarning()

func mustMarshalStaleSyncWarning() []byte {
	b, err := json.Marshal(struct {
		Kind  string `json:"kind"`
		Title string `json:"title"`
		Body  string `json:"body"`
	}{Kind: "server-warning", Title: "Med Tracker", Body: "Open the app to keep reminders running"})
	if err != nil {
		panic(err) // static literal — cannot fail
	}
	return b
}

// PushSender delivers one already-encrypted payload to one subscription,
// signed with that subscription's account's own VAPID keypair, and reports
// the push service's HTTP status (or a transport error). Swappable in tests
// for a fake that never hits the network.
type PushSender interface {
	Send(ctx context.Context, sub cloudstore.PushSubscription, keys cloudstore.AccountVAPIDKeys, ct []byte) (statusCode int, err error)
}

// TelegramSender forwards one client-composed reminder to an account's linked
// Telegram bot. Deliberately narrow: the relay hands over bytes it was given
// and learns nothing else about the account. Nil when the deployment has no
// manager bot configured, in which case telegram entries are dropped.
type TelegramSender interface {
	SendReminder(ctx context.Context, accountID, text, callbackStem string) (int64, error)
	// DeleteReminder best-effort deletes a previously-sent reminder message so a
	// re-fire leaves one live message per chain. Account-scoped: it resolves the
	// chat internally, so the relay never touches a chat_id.
	DeleteReminder(ctx context.Context, accountID string, messageID int64) error
}

// WebPushSender is the production PushSender. ct is already NK-encrypted
// app-layer ciphertext (see docs/cloud-crypto.md); webpush-go wraps it in
// RFC 8291 per subscription — the relay composes nothing and can read
// nothing. The VAPID keypair is per-account (passed into Send), not held
// here; Subject/BaseDomain are service-wide (RFC 8292 identifies the relay
// operator, never the user).
type WebPushSender struct {
	Subject    string
	BaseDomain string
}

func (s *WebPushSender) Send(ctx context.Context, sub cloudstore.PushSubscription, keys cloudstore.AccountVAPIDKeys, ct []byte) (int, error) {
	resp, err := webpush.SendNotificationWithContext(ctx, ct, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{Auth: sub.Auth, P256dh: sub.P256dh},
	}, &webpush.Options{
		HTTPClient:      &http.Client{Timeout: 10 * time.Second},
		Subscriber:      vapidSubjectFor(sub.Endpoint, s.Subject, s.BaseDomain),
		VAPIDPublicKey:  keys.PublicKey,
		VAPIDPrivateKey: keys.PrivateKey,
		TTL:             12 * 3600,
	})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// vapidSubjectFor picks the RFC 8292 VAPID subject for one push-service
// endpoint. Apple's push service rejects a mailto: subject and requires an
// https:// one; FCM/Mozilla expect the configured mailto:. Cloud-local copy
// of the switch in internal/webpush/webpush.go (bot mode) — kept separate
// since that version is entangled with bot config.
func vapidSubjectFor(endpoint, subject, baseDomain string) string {
	if strings.Contains(endpoint, "push.apple.com") {
		return "https://" + baseDomain
	}
	return subject
}

// relayStore is the subset of *cloudstore.Repo the blind push relay needs.
type relayStore interface {
	DueScheduledPushes(ctx context.Context, now time.Time) ([]cloudstore.ScheduledPush, error)
	MarkPushSent(ctx context.Context, id int64, sentAt time.Time) error
	List(ctx context.Context, accountID string) ([]cloudstore.PushSubscription, error)
	Disable(ctx context.Context, endpoint string) error
	AccountsNeedingStaleSyncWarning(ctx context.Context, now time.Time, dryQueueWithin, staleAfter, warnCooldown time.Duration) ([]string, error)
	MarkStaleSyncWarned(ctx context.Context, accountID string, now time.Time) error
	AccountVAPIDKeysByID(ctx context.Context, accountID string) (cloudstore.AccountVAPIDKeys, error)
	RescheduleRelayRefire(ctx context.Context, accountID string, fireAt time.Time, tgText, tgCallback string, supersedesMessageID int64) error
}

// Relay is the blind push-firing loop: it never decrypts or composes a
// payload, only forwards each due scheduled_pushes.ct blob to every enabled
// subscription for that account. It also runs Task 7's hourly stale-sync
// sweep, which is the one exception that composes its own (content-free)
// payload server-side.
type Relay struct {
	store              relayStore
	sender             PushSender
	tg                 TelegramSender // nil when no manager bot is configured
	interval           time.Duration
	dryQueueWarnWithin time.Duration
}

// NewRelay builds a Relay that ticks every 30s. dryQueueWarnWithin is
// CLOUD_DRY_QUEUE_WARN_HOURS (Task 7); <= 0 uses the 120h default. tg may be
// nil — the relay then serves web-push entries only.
func NewRelay(store relayStore, sender PushSender, tg TelegramSender, dryQueueWarnWithin time.Duration) *Relay {
	if dryQueueWarnWithin <= 0 {
		dryQueueWarnWithin = defaultDryQueueWarnWithin
	}
	return &Relay{store: store, sender: sender, tg: tg, interval: 30 * time.Second, dryQueueWarnWithin: dryQueueWarnWithin}
}

// Run ticks until ctx is cancelled. Call it in its own goroutine, passing the
// same context the HTTP server shuts down on, so the relay stops with it.
func (rl *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(rl.interval)
	defer ticker.Stop()
	staleTicker := time.NewTicker(staleSweepInterval)
	defer staleTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rl.Tick(ctx)
		case <-staleTicker.C:
			rl.StaleSyncSweep(ctx)
		}
	}
}

// Tick runs one due-push sweep. Exported so tests can drive it without
// waiting on the real ticker interval.
func (rl *Relay) Tick(ctx context.Context) {
	due, err := rl.store.DueScheduledPushes(ctx, time.Now().UTC())
	if err != nil {
		slog.Error("push relay: list due pushes", "error", err)
		return
	}

	subsByAccount := make(map[string][]cloudstore.PushSubscription)
	keysByAccount := make(map[string]cloudstore.AccountVAPIDKeys)
	for _, p := range due {
		// An empty delivery is a pre-C3b row: web push, as before.
		delivery := p.Delivery
		if delivery == "" {
			delivery = cloudstore.DeliveryWebPush
		}

		if delivery == cloudstore.DeliveryWebPush || delivery == cloudstore.DeliveryBoth {
			rl.sendWebPush(ctx, p, subsByAccount, keysByAccount)
		}

		if delivery == cloudstore.DeliveryTelegram || delivery == cloudstore.DeliveryBoth {
			rl.sendTelegram(ctx, p)
		}

		// Mark sent whatever happened on either channel: delivery is
		// at-most-once. Retrying a "both" entry because its web-push half hit a
		// lookup error would re-send its Telegram half, and a permanently
		// unlinked chat or revoked token would re-fire forever. A DB outage
		// fails MarkPushSent too, so the row is naturally retried then.
		if err := rl.store.MarkPushSent(ctx, p.ID, time.Now().UTC()); err != nil {
			slog.Error("push relay: mark sent", "id", p.ID, "error", err)
		}
	}
}

// sendWebPush fans one due entry out to every enabled subscription for its
// account, memoizing the per-account subscription list and VAPID keys across
// the tick.
func (rl *Relay) sendWebPush(
	ctx context.Context,
	p cloudstore.ScheduledPush,
	subsByAccount map[string][]cloudstore.PushSubscription,
	keysByAccount map[string]cloudstore.AccountVAPIDKeys,
) {
	subs, ok := subsByAccount[p.AccountID]
	if !ok {
		var err error
		subs, err = rl.store.List(ctx, p.AccountID)
		if err != nil {
			slog.Error("push relay: list subscriptions", "accountID", p.AccountID, "error", err)
			return
		}
		subsByAccount[p.AccountID] = subs
	}

	keys, ok := keysByAccount[p.AccountID]
	if !ok {
		var err error
		keys, err = rl.store.AccountVAPIDKeysByID(ctx, p.AccountID)
		if err != nil {
			slog.Error("push relay: load VAPID keys", "accountID", p.AccountID, "error", err)
			return
		}
		keysByAccount[p.AccountID] = keys
	}

	if keys.PublicKey == "" || keys.PrivateKey == "" {
		slog.Warn("push relay: account has no VAPID keys, skipping send", "accountID", p.AccountID)
		return
	}
	for _, sub := range subs {
		rl.send(ctx, sub, keys, p.CT)
	}
}

// sendTelegram forwards p.TGText to the account's linked bot. Every failure is
// logged and swallowed: the caller still marks the row sent, so a revoked token
// or an account that never tapped /start cannot re-fire the same reminder on
// every tick forever.
func (rl *Relay) sendTelegram(ctx context.Context, p cloudstore.ScheduledPush) {
	if rl.tg == nil {
		slog.Warn("push relay: telegram entry but no telegram sender configured", "accountID", p.AccountID)
		return
	}
	newID, err := rl.tg.SendReminder(ctx, p.AccountID, p.TGText, p.TGCallback)
	if err != nil {
		slog.Error("push relay: telegram send", "accountID", p.AccountID, "error", err)
		return
	}
	// Best-effort: delete the prior message in this chain so exactly one live
	// reminder remains. A failed delete (already gone / >48h old) never aborts.
	if p.SupersedesMessageID != 0 {
		if err := rl.tg.DeleteReminder(ctx, p.AccountID, p.SupersedesMessageID); err != nil {
			slog.Warn("push relay: delete superseded reminder", "accountID", p.AccountID, "error", err)
		}
	}
	rl.scheduleMedRefire(ctx, p, newID)
}

// scheduleMedRefire chains the next re-fire of an unconfirmed med reminder. When
// a med send ("s:<slotUnix>" callback, not a workout "w:" one) succeeds and the
// dose slot is still within maxMedRefireWindow, it schedules the next re-fire at
// now+1h; a Confirm/Snooze tap (which cancels/reschedules the same callback key)
// or crossing the window ends the chain. Both the primary send and each
// relay_refire flow through here, so the hourly nag perpetuates without a
// counter. Zero-knowledge: it copies only the already-cleartext tg_text/callback.
func (rl *Relay) scheduleMedRefire(ctx context.Context, p cloudstore.ScheduledPush, supersedesMessageID int64) {
	rest, ok := strings.CutPrefix(p.TGCallback, tgclient.CallbackSlotPrefix)
	if !ok {
		return // not a med dose reminder (e.g. a workout re-fire owns its own chain)
	}
	slotUnix, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return // malformed stem — never render a nag we can't reason about
	}
	now := time.Now().UTC()
	if now.Sub(time.Unix(slotUnix, 0).UTC()) > maxMedRefireWindow {
		return // past the cap: stop nagging
	}
	if err := rl.store.RescheduleRelayRefire(ctx, p.AccountID, now.Add(time.Hour), p.TGText, p.TGCallback, supersedesMessageID); err != nil {
		slog.Error("push relay: schedule med refire", "accountID", p.AccountID, "error", err)
	}
}

// StaleSyncSweep sends the generic dry-queue warning (Task 7) to every
// account whose scheduled-push queue is about to run dry while the account
// hasn't synced recently, at most once per warnCooldown per account. Exported
// so tests can drive it without waiting on the hourly ticker.
func (rl *Relay) StaleSyncSweep(ctx context.Context) {
	now := time.Now().UTC()
	accountIDs, err := rl.store.AccountsNeedingStaleSyncWarning(ctx, now, rl.dryQueueWarnWithin, staleSyncAfter, warnCooldown)
	if err != nil {
		slog.Error("push relay: list stale-sync accounts", "error", err)
		return
	}

	for _, accountID := range accountIDs {
		subs, err := rl.store.List(ctx, accountID)
		if err != nil {
			slog.Error("push relay: list subscriptions for stale-sync warning", "accountID", accountID, "error", err)
			continue
		}
		keys, err := rl.store.AccountVAPIDKeysByID(ctx, accountID)
		if err != nil {
			slog.Error("push relay: load VAPID keys for stale-sync warning", "accountID", accountID, "error", err)
			continue
		}
		if keys.PublicKey == "" || keys.PrivateKey == "" {
			slog.Warn("push relay: account has no VAPID keys, skipping stale-sync warning", "accountID", accountID)
		} else {
			for _, sub := range subs {
				rl.send(ctx, sub, keys, staleSyncWarningPayload)
			}
		}
		if err := rl.store.MarkStaleSyncWarned(ctx, accountID, now); err != nil {
			slog.Error("push relay: mark stale-sync warned", "accountID", accountID, "error", err)
		}
	}
}

func (rl *Relay) send(ctx context.Context, sub cloudstore.PushSubscription, keys cloudstore.AccountVAPIDKeys, ct []byte) {
	sendCtx, cancel := context.WithTimeout(ctx, relaySendTimeout)
	defer cancel()

	status, err := rl.sender.Send(sendCtx, sub, keys, ct)
	if err != nil {
		// err from webpush-go is a raw *url.Error whose Error() embeds the full
		// endpoint URL — unwrap it so the fingerprint stays the only endpoint
		// reference in the log (bd med-yor.16).
		slog.Error("push relay: send failed", "endpoint_fp", endpointFingerprint(sub.Endpoint), "error", urlErrCause(err))
		return
	}
	if status == http.StatusNotFound || status == http.StatusGone {
		if err := rl.store.Disable(ctx, sub.Endpoint); err != nil {
			slog.Error("push relay: disable subscription", "endpoint_fp", endpointFingerprint(sub.Endpoint), "error", err)
		}
	}
}
