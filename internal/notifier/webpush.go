package notifier

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/webpush"
)

// WebPush implements Notifier by delegating to *webpush.Service.
type WebPush struct {
	svc *webpush.Service
}

// NewWebPush creates a Notifier that sends via Web Push.
func NewWebPush(svc *webpush.Service) *WebPush {
	return &WebPush{svc: svc}
}

func (w *WebPush) Send(_ context.Context, userID int64, n Notification) (int, error) {
	actions := make([]webpush.NotificationAction, len(n.Actions))
	for i, a := range n.Actions {
		actions[i] = webpush.NotificationAction{
			Action: a.ID,
			Title:  a.Label,
		}
	}

	payload := webpush.NotificationPayload{
		Title:   StripMarkdown(firstLine(n.Text)),
		Body:    StripMarkdown(n.Text),
		Icon:    "/static/icons/icon-192.png",
		Tag:     n.Tag,
		Data:    n.Metadata,
		Actions: actions,
	}

	if err := w.svc.SendNotification(userID, payload); err != nil {
		return 0, err
	}
	// WebPush doesn't support message ID tracking
	return 0, nil
}

func (w *WebPush) Delete(_ context.Context, _ int64, _ int) error {
	// WebPush doesn't support deleting notifications
	return nil
}

// firstLine returns the first non-empty line of s.
func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}
