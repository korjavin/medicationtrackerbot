//go:build mobile

package scheduler

import (
	"context"
	"log/slog"
	"sync"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// LocalNotificationSink is the mobile-build ReminderSink. It does not push
// reminders out over the network — instead it logs them and keeps a small
// in-memory ring of recent reminders for diagnostics. The actual native
// scheduling happens client-side: the Capacitor app polls
// GET /api/reminders/upcoming and hands each entry to
// @capacitor/local-notifications, which iOS/Android then fire regardless of
// whether the webview is alive.
//
// HasChannel always returns true: from the scheduler's perspective the mobile
// app IS the channel, even though delivery is fully asynchronous.
type LocalNotificationSink struct {
	allowedUserID int64

	mu     sync.Mutex
	recent []recordedNotification
	maxLen int
	nextID int
}

type recordedNotification struct {
	MsgID  int
	UserID int64
	N      notifier.Notification
}

// NewLocalNotificationSink constructs a sink for the mobile build. It keeps at
// most maxLen most-recent notifications in memory (used by tests; production
// callers can leave it at the default of 128 by passing 0).
func NewLocalNotificationSink(allowedUserID int64) *LocalNotificationSink {
	return &LocalNotificationSink{
		allowedUserID: allowedUserID,
		maxLen:        128,
	}
}

// HasChannel returns true: mobile builds always have the local app as the
// (asynchronous) delivery channel.
func (s *LocalNotificationSink) HasChannel() bool { return true }

// Notify records the notification and assigns it a synthetic message ID so
// callers that track msgIDs continue to work.
func (s *LocalNotificationSink) Notify(_ context.Context, n notifier.Notification, storeMsgID func(int)) {
	msgID := s.record(s.allowedUserID, n)
	slog.Info("local-notification queued", "user_id", s.allowedUserID, "msg_id", msgID, "tag", n.Tag)
	if storeMsgID != nil && msgID != 0 {
		storeMsgID(msgID)
	}
}

// NotifySync records the notification synchronously and returns nil. The
// mobile JS bridge will materialize this into a native notification on next
// poll, so the scheduler should never treat the call as failed.
func (s *LocalNotificationSink) NotifySync(_ context.Context, n notifier.Notification, storeMsgID func(int)) error {
	msgID := s.record(s.allowedUserID, n)
	slog.Info("local-notification queued (sync)", "user_id", s.allowedUserID, "msg_id", msgID, "tag", n.Tag)
	if storeMsgID != nil && msgID != 0 {
		storeMsgID(msgID)
	}
	return nil
}

// NotifySyncToUser records the notification against an explicit user ID. On
// mobile there's only one user, but the BP and weight reminder checkers iterate
// users from the store so we accept the parameter rather than asserting.
func (s *LocalNotificationSink) NotifySyncToUser(_ context.Context, userID int64, n notifier.Notification) (int, error) {
	msgID := s.record(userID, n)
	slog.Info("local-notification queued (sync, explicit user)", "user_id", userID, "msg_id", msgID, "tag", n.Tag)
	return msgID, nil
}

// DeleteNotification removes a previously recorded notification by ID.
func (s *LocalNotificationSink) DeleteNotification(_ context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	filtered := s.recent[:0]
	for _, r := range s.recent {
		if r.MsgID != msgID {
			filtered = append(filtered, r)
		}
	}
	s.recent = filtered
}

// Recent returns a snapshot of the most recently queued notifications.
// Used by tests; the HTTP endpoint reads its data from intake_log instead.
func (s *LocalNotificationSink) Recent() []recordedNotification {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]recordedNotification, len(s.recent))
	copy(out, s.recent)
	return out
}

func (s *LocalNotificationSink) record(userID int64, n notifier.Notification) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	msgID := s.nextID
	s.recent = append(s.recent, recordedNotification{MsgID: msgID, UserID: userID, N: n})
	if len(s.recent) > s.maxLen {
		s.recent = s.recent[len(s.recent)-s.maxLen:]
	}
	return msgID
}

// defaultSink is the mobile-build tag-aware sink factory. The server-build
// equivalent lives in sink_webpush.go. The notifiers slice is ignored — mobile
// delivery happens via the @capacitor/local-notifications JS bridge, not via
// any of the notifier.Notifier implementations (Telegram, web push).
func defaultSink(_ []notifier.Notifier, allowedUserID int64) ReminderSink {
	return NewLocalNotificationSink(allowedUserID)
}
