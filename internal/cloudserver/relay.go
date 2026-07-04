package cloudserver

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// relaySendTimeout bounds a single subscription's push-service round trip so
// one slow endpoint can't stall an entire tick.
const relaySendTimeout = 10 * time.Second

// PushSender delivers one already-encrypted payload to one subscription and
// reports the push service's HTTP status (or a transport error). Swappable
// in tests for a fake that never hits the network.
type PushSender interface {
	Send(ctx context.Context, sub cloudstore.PushSubscription, ct []byte) (statusCode int, err error)
}

// WebPushSender is the production PushSender. ct is already NK-encrypted
// app-layer ciphertext (see docs/cloud-crypto.md); webpush-go wraps it in
// RFC 8291 per subscription — the relay composes nothing and can read
// nothing.
type WebPushSender struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
}

func (s *WebPushSender) Send(ctx context.Context, sub cloudstore.PushSubscription, ct []byte) (int, error) {
	resp, err := webpush.SendNotificationWithContext(ctx, ct, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{Auth: sub.Auth, P256dh: sub.P256dh},
	}, &webpush.Options{
		Subscriber:      s.VAPIDSubject,
		VAPIDPublicKey:  s.VAPIDPublicKey,
		VAPIDPrivateKey: s.VAPIDPrivateKey,
		TTL:             12 * 3600,
	})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// relayStore is the subset of *cloudstore.Repo the blind push relay needs.
type relayStore interface {
	DueScheduledPushes(ctx context.Context, now time.Time) ([]cloudstore.ScheduledPush, error)
	MarkPushSent(ctx context.Context, id int64, sentAt time.Time) error
	List(ctx context.Context, accountID string) ([]cloudstore.PushSubscription, error)
	Disable(ctx context.Context, endpoint string) error
}

// Relay is the blind push-firing loop: it never decrypts or composes a
// payload, only forwards each due scheduled_pushes.ct blob to every enabled
// subscription for that account.
type Relay struct {
	store    relayStore
	sender   PushSender
	interval time.Duration
}

// NewRelay builds a Relay that ticks every 30s.
func NewRelay(store relayStore, sender PushSender) *Relay {
	return &Relay{store: store, sender: sender, interval: 30 * time.Second}
}

// Run ticks until ctx is cancelled. Call it in its own goroutine, passing the
// same context the HTTP server shuts down on, so the relay stops with it.
func (rl *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(rl.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rl.Tick(ctx)
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
	for _, p := range due {
		subs, ok := subsByAccount[p.AccountID]
		if !ok {
			subs, err = rl.store.List(ctx, p.AccountID)
			if err != nil {
				slog.Error("push relay: list subscriptions", "accountID", p.AccountID, "error", err)
				continue
			}
			subsByAccount[p.AccountID] = subs
		}

		for _, sub := range subs {
			rl.send(ctx, sub, p.CT)
		}

		if err := rl.store.MarkPushSent(ctx, p.ID, time.Now().UTC()); err != nil {
			slog.Error("push relay: mark sent", "id", p.ID, "error", err)
		}
	}
}

func (rl *Relay) send(ctx context.Context, sub cloudstore.PushSubscription, ct []byte) {
	sendCtx, cancel := context.WithTimeout(ctx, relaySendTimeout)
	defer cancel()

	status, err := rl.sender.Send(sendCtx, sub, ct)
	if err != nil {
		slog.Error("push relay: send failed", "endpoint", sub.Endpoint, "error", err)
		return
	}
	if status == http.StatusNotFound || status == http.StatusGone {
		if err := rl.store.Disable(ctx, sub.Endpoint); err != nil {
			slog.Error("push relay: disable subscription", "endpoint", sub.Endpoint, "error", err)
		}
	}
}
