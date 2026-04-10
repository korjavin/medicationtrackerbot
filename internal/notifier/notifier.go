package notifier

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

// ErrNoDeliveryChannel is returned by a Notifier.Send implementation when the
// notifier is configured but has no active recipients (e.g. no push
// subscriptions registered). Callers can use errors.Is to distinguish this
// from a transient send failure and avoid tight retry loops.
var ErrNoDeliveryChannel = errors.New("notifier: no delivery channel available")

// Action represents an interactive button attached to a notification.
type Action struct {
	ID    string // callback data, e.g. "confirm_intake:123", "workout_start_5"
	Label string // button text, e.g. "✅ Confirm Intake", "▶️ Start Now"
}

// Notification describes a notification to be sent through any channel.
type Notification struct {
	Text     string                 // Markdown-formatted text
	Actions  []Action               // Action buttons
	Tag      string                 // For grouping (WebPush uses, Telegram ignores)
	Metadata map[string]any // Extra data (WebPush Data field, Telegram ignores)
}

// Notifier abstracts notification sending/deleting across channels.
type Notifier interface {
	// Send sends a notification. Returns a message ID (0 if channel doesn't support tracking).
	Send(ctx context.Context, userID int64, n Notification) (int, error)

	// Delete removes a previously sent notification. No-op if msgID is 0 or channel doesn't support it.
	Delete(ctx context.Context, userID int64, msgID int) error

	// CloseNotification closes a previously sent notification based on tag (e.g. WebPush).
	CloseNotification(ctx context.Context, userID int64, tag string) error
}

var boldRegexp = regexp.MustCompile(`\*\*(.+?)\*\*`)
var italicRegexp = regexp.MustCompile(`\*(.+?)\*`)

// StripMarkdown removes basic Markdown formatting for plain-text channels.
func StripMarkdown(s string) string {
	// Remove bold **text** → text
	s = boldRegexp.ReplaceAllString(s, "$1")
	// Remove italic *text* → text
	s = italicRegexp.ReplaceAllString(s, "$1")
	// Remove inline code `text` → text
	s = strings.ReplaceAll(s, "`", "")
	return s
}
