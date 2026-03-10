package notifier

import (
	"context"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
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

func (w *WebPush) Send(ctx context.Context, userID int64, n Notification) (int, error) {
	// Skip sending batched medication notifications via WebPush, we send individual ones instead
	if n.Metadata != nil && n.Metadata["type"] == "medication_batch" {
		return 0, nil
	}

	// For medication_individual, we use the specific method since we need to extract data
	if n.Metadata != nil && n.Metadata["type"] == "medication_individual" {
		med := store.Medication{
			ID:   n.Metadata["medication_id"].(int64),
			Name: strings.Replace(n.Text, "💊 Time to take: ", "", 1),
		}

		var scheduled time.Time
		if s, ok := n.Metadata["scheduled_at"].(string); ok {
			scheduled, _ = time.Parse(time.RFC3339, s)
		}

		err := w.svc.SendMedicationNotification(ctx, userID, med, scheduled, n.Metadata["intake_id"].(int64))
		return 0, err
	}

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
	// WebPush doesn't support deleting notifications by ID
	return nil
}

func (w *WebPush) CloseNotification(ctx context.Context, userID int64, tag string) error {
	return w.svc.SendCloseNotification(ctx, userID, tag)
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
