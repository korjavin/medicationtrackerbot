//go:build !mobile

package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// WebPushSink is the server-build ReminderSink. It fans notifications out
// across the configured notifier.Notifier set (typically Telegram + Web Push)
// addressed to allowedUserID. Task 6 of the local-only-mode plan tags this
// file with //go:build !mobile and adds a sibling sink_localnotifications.go
// for the mobile build.
type WebPushSink struct {
	notifiers     []notifier.Notifier
	allowedUserID int64
}

// NewWebPushSink constructs a sink dispatching via notifiers addressed to
// allowedUserID. Passing an empty slice yields a sink with HasChannel() == false;
// callers (notably TZPlanNotifier) use that to short-circuit plans that have
// nowhere to be delivered.
func NewWebPushSink(notifiers []notifier.Notifier, allowedUserID int64) *WebPushSink {
	return &WebPushSink{notifiers: notifiers, allowedUserID: allowedUserID}
}

// defaultSink is the server-build tag-aware sink factory. The mobile-build
// equivalent lives in sink_localnotifications.go.
func defaultSink(notifiers []notifier.Notifier, allowedUserID int64) ReminderSink {
	return NewWebPushSink(notifiers, allowedUserID)
}

// HasChannel reports whether any notifier is configured.
func (s *WebPushSink) HasChannel() bool {
	return len(s.notifiers) > 0
}

// Notify sends a notification through all configured notifiers asynchronously.
// If storeMsgID is non-nil, the first non-zero message ID is passed to it.
func (s *WebPushSink) Notify(ctx context.Context, n notifier.Notification, storeMsgID func(int)) {
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			msgID, err := nr.Send(ctx, s.allowedUserID, n)
			if err != nil {
				slog.Error("Notification send failed", "notifier", nr, "error", err)
				return
			}
			if msgID != 0 && storeMsgID != nil {
				storeMsgID(msgID)
			}
		}(nr)
	}
}

// NotifySync sends a notification through all notifiers synchronously.
// Returns nil if at least one notifier succeeds. Returns the last transient
// error if all fail. If all notifiers fail with ErrNoDeliveryChannel, that
// sentinel is returned. If any notifier fails with a different (transient)
// error, that error is returned instead — so callers don't mistake a partial
// outage for "no delivery channel at all".
func (s *WebPushSink) NotifySync(ctx context.Context, n notifier.Notification, storeMsgID func(int)) error {
	var lastTransientErr error
	successCount := 0
	allNoChannel := true
	for _, nr := range s.notifiers {
		msgID, err := nr.Send(ctx, s.allowedUserID, n)
		if err != nil {
			slog.Error("Notification send failed", "notifier", nr, "error", err)
			if !errors.Is(err, notifier.ErrNoDeliveryChannel) {
				allNoChannel = false
				lastTransientErr = err
			}
			continue
		}
		successCount++
		if msgID != 0 && storeMsgID != nil {
			storeMsgID(msgID)
		}
	}
	if successCount == 0 && len(s.notifiers) > 0 {
		if allNoChannel {
			return notifier.ErrNoDeliveryChannel
		}
		return lastTransientErr
	}
	return nil
}

// NotifySyncToUser sends a notification synchronously to a specific user ID.
// Returns the first non-zero message ID from a successful channel (0 if none
// reported one) and an error if every channel failed. The error preserves
// notifier.ErrNoDeliveryChannel when every notifier reported "no channel" so
// callers can tell "user has no push subscription" apart from "transient
// provider failure".
func (s *WebPushSink) NotifySyncToUser(ctx context.Context, userID int64, n notifier.Notification) (int, error) {
	anySuccess := false
	allNoChannel := true
	var firstMsgID int
	var lastTransientErr error
	for _, nr := range s.notifiers {
		msgID, err := nr.Send(ctx, userID, n)
		if err != nil {
			slog.Error("Notification send failed", "notifier", nr, "error", err)
			if !errors.Is(err, notifier.ErrNoDeliveryChannel) {
				allNoChannel = false
				lastTransientErr = err
			}
			continue
		}
		anySuccess = true
		if msgID != 0 && firstMsgID == 0 {
			firstMsgID = msgID
		}
	}
	if !anySuccess {
		if len(s.notifiers) > 0 && allNoChannel {
			return 0, notifier.ErrNoDeliveryChannel
		}
		if lastTransientErr != nil {
			return 0, lastTransientErr
		}
		return 0, fmt.Errorf("failed to send notification via any channel")
	}
	return firstMsgID, nil
}

// DeleteNotification deletes a previously sent notification from all notifiers.
func (s *WebPushSink) DeleteNotification(ctx context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.Delete(ctx, s.allowedUserID, msgID); err != nil {
				slog.Error("Notification delete failed", "notifier", nr, "error", err)
			}
		}(nr)
	}
}
