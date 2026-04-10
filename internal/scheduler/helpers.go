package scheduler

import (
	"context"
	"errors"
	"log/slog"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// NotifyHelper provides fire-and-forget notification methods.
// Embed this in checkers that use the async notification pattern.
type NotifyHelper struct {
	notifiers     []notifier.Notifier
	allowedUserID int64
}

// Notify sends a notification through all configured notifiers asynchronously.
// If storeMsgID is non-nil, the first non-zero message ID is passed to it.
func (h *NotifyHelper) Notify(ctx context.Context, n notifier.Notification, storeMsgID func(int)) {
	for _, nr := range h.notifiers {
		go func(nr notifier.Notifier) {
			msgID, err := nr.Send(ctx, h.allowedUserID, n)
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
// Returns nil if at least one notifier succeeds. Returns the last error if all fail.
// If all notifiers fail with ErrNoDeliveryChannel, that sentinel is returned.
// If any notifier fails with a different (transient) error, that error is returned
// instead — so callers don't mistake a partial outage for "no delivery channel at all".
func (h *NotifyHelper) NotifySync(ctx context.Context, n notifier.Notification, storeMsgID func(int)) error {
	var lastTransientErr error
	successCount := 0
	allNoChannel := true
	for _, nr := range h.notifiers {
		msgID, err := nr.Send(ctx, h.allowedUserID, n)
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
	if successCount == 0 && len(h.notifiers) > 0 {
		if allNoChannel {
			return notifier.ErrNoDeliveryChannel
		}
		return lastTransientErr
	}
	return nil
}

// DeleteNotification deletes a previously sent notification from all notifiers.
func (h *NotifyHelper) DeleteNotification(ctx context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	for _, nr := range h.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.Delete(ctx, h.allowedUserID, msgID); err != nil {
				slog.Error("Notification delete failed", "notifier", nr, "error", err)
			}
		}(nr)
	}
}
