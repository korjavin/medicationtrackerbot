package scheduler

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// ReminderSink is the scheduler's delivery boundary for reminder notifications.
//
// Server builds use WebPushSink, which fans out across the configured
// notifier.Notifier set (Telegram + Web Push). The mobile build (added in
// Task 6 of the local-only-mode plan) substitutes a different implementation
// that queues reminders for retrieval over an HTTP endpoint, so the Capacitor
// app can hand them to @capacitor/local-notifications. Checkers depend only
// on this interface — they don't know or care which sink is wired in.
type ReminderSink interface {
	// Notify dispatches a notification asynchronously to the sink's default
	// user. storeMsgID receives the first non-zero message ID returned by an
	// underlying channel; pass nil to ignore the ID.
	Notify(ctx context.Context, n notifier.Notification, storeMsgID func(int))

	// NotifySync dispatches a notification synchronously to the sink's default
	// user. Returns nil if at least one channel succeeded. Returns
	// notifier.ErrNoDeliveryChannel if every channel reported no delivery
	// target. Returns another error if every channel failed transiently (i.e.
	// callers can distinguish "no channel" from "all channels broken").
	NotifySync(ctx context.Context, n notifier.Notification, storeMsgID func(int)) error

	// NotifySyncToUser is NotifySync addressed to an explicit user ID. Used by
	// the BP and weight reminder checkers, which iterate users from the store
	// rather than relying on the sink's default user. Returns the first
	// non-zero message ID from a successful channel (0 if none reported one)
	// and an error if every channel failed.
	NotifySyncToUser(ctx context.Context, userID int64, n notifier.Notification) (msgID int, err error)

	// DeleteNotification asynchronously removes a previously sent message by
	// ID. No-op if msgID is 0.
	DeleteNotification(ctx context.Context, msgID int)

	// HasChannel reports whether the sink has at least one delivery channel
	// configured. TZPlanNotifier uses this to cancel plans that would
	// otherwise queue forever on a web-only deployment without WebPush.
	HasChannel() bool
}
