package scheduler

import (
	"context"
	"log"

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
				log.Printf("Notification send failed (%T): %v", nr, err)
				return
			}
			if msgID != 0 && storeMsgID != nil {
				storeMsgID(msgID)
			}
		}(nr)
	}
}

// DeleteNotification deletes a previously sent notification from all notifiers.
func (h *NotifyHelper) DeleteNotification(ctx context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	for _, nr := range h.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.Delete(ctx, h.allowedUserID, msgID); err != nil {
				log.Printf("Notification delete failed (%T): %v", nr, err)
			}
		}(nr)
	}
}
