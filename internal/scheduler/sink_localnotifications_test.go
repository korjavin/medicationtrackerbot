//go:build mobile

package scheduler

import (
	"context"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

func TestLocalNotificationSink_HasChannel(t *testing.T) {
	s := NewLocalNotificationSink(1)
	if !s.HasChannel() {
		t.Error("HasChannel() should be true on mobile — local app is the (async) channel")
	}
}

func TestLocalNotificationSink_NotifyAssignsMsgID(t *testing.T) {
	s := NewLocalNotificationSink(1)
	var observed int
	s.Notify(context.Background(), notifier.Notification{Text: "hi"}, func(id int) { observed = id })
	if observed == 0 {
		t.Fatal("expected non-zero msgID to be reported to storeMsgID callback")
	}

	recent := s.Recent()
	if len(recent) != 1 {
		t.Fatalf("Recent() len = %d, want 1", len(recent))
	}
	if recent[0].MsgID != observed {
		t.Errorf("Recent msgID = %d, observed via callback = %d", recent[0].MsgID, observed)
	}
	if recent[0].UserID != 1 {
		t.Errorf("UserID = %d, want 1", recent[0].UserID)
	}
}

func TestLocalNotificationSink_NotifySyncReturnsNil(t *testing.T) {
	s := NewLocalNotificationSink(1)
	err := s.NotifySync(context.Background(), notifier.Notification{Text: "hi"}, nil)
	if err != nil {
		t.Errorf("NotifySync should not return error on mobile, got %v", err)
	}
	if len(s.Recent()) != 1 {
		t.Errorf("expected 1 recorded notification, got %d", len(s.Recent()))
	}
}

func TestLocalNotificationSink_NotifySyncToUserUsesExplicitUserID(t *testing.T) {
	s := NewLocalNotificationSink(1)
	msgID, err := s.NotifySyncToUser(context.Background(), 999, notifier.Notification{Text: "explicit"})
	if err != nil {
		t.Fatalf("NotifySyncToUser returned error: %v", err)
	}
	if msgID == 0 {
		t.Error("expected non-zero msgID")
	}
	recent := s.Recent()
	if len(recent) != 1 {
		t.Fatalf("len = %d, want 1", len(recent))
	}
	if recent[0].UserID != 999 {
		t.Errorf("UserID = %d, want 999 (explicit, not sink default)", recent[0].UserID)
	}
}

func TestLocalNotificationSink_DeleteRemovesFromRecent(t *testing.T) {
	s := NewLocalNotificationSink(1)
	var firstID int
	s.Notify(context.Background(), notifier.Notification{Text: "first"}, func(id int) { firstID = id })
	s.Notify(context.Background(), notifier.Notification{Text: "second"}, nil)

	s.DeleteNotification(context.Background(), firstID)

	recent := s.Recent()
	if len(recent) != 1 {
		t.Fatalf("after delete, Recent len = %d, want 1", len(recent))
	}
	if recent[0].N.Text != "second" {
		t.Errorf("expected only 'second' to remain, got %q", recent[0].N.Text)
	}
}

func TestLocalNotificationSink_DeleteZeroIsNoOp(t *testing.T) {
	s := NewLocalNotificationSink(1)
	s.Notify(context.Background(), notifier.Notification{Text: "x"}, nil)
	s.DeleteNotification(context.Background(), 0)
	if len(s.Recent()) != 1 {
		t.Error("DeleteNotification(0) should be no-op")
	}
}

// TestDefaultSink_OnMobileReturnsLocalSink verifies the tag-aware factory.
// In mobile builds, defaultSink ignores the notifiers slice and returns a
// LocalNotificationSink.
func TestDefaultSink_OnMobileReturnsLocalSink(t *testing.T) {
	sink := defaultSink(nil, 42)
	if _, ok := sink.(*LocalNotificationSink); !ok {
		t.Fatalf("defaultSink on mobile build should return *LocalNotificationSink, got %T", sink)
	}
}
