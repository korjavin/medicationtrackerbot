package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/stretchr/testify/assert"
)

type mockBPReminderStoreFallback struct {
	users  []int64
	states map[int64]*store.BPReminderState
	reads  map[int64]*store.BloodPressure
}

func (m *mockBPReminderStoreFallback) GetBloodPressureEnabled(ctx context.Context) (bool, error) { return true, nil }
func (m *mockBPReminderStoreFallback) GetUsersForBPReminders() ([]int64, error) { return m.users, nil }
func (m *mockBPReminderStoreFallback) GetBPReminderState(userID int64) (*store.BPReminderState, error) {
	if s, ok := m.states[userID]; ok { return s, nil }
	return nil, assert.AnError
}
func (m *mockBPReminderStoreFallback) GetLastBPReading(ctx context.Context, userID int64) (*store.BloodPressure, error) {
	if r, ok := m.reads[userID]; ok { return r, nil }
	return nil, nil // Nil reading is valid
}
func (m *mockBPReminderStoreFallback) CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error) { return 20, nil }
func (m *mockBPReminderStoreFallback) UpdatePreferredReminderHour(userID int64, hour int) error { return nil }
func (m *mockBPReminderStoreFallback) GetDominantBPCategory(ctx context.Context, userID int64) (string, error) { return "Normal", nil }
func (m *mockBPReminderStoreFallback) UpdateBPReminderNotificationSent(userID int64, messageID *int) error { return nil }
func (m *mockBPReminderStoreFallback) GetCurrentTimezone() (string, error) { return "", nil }

// Simulate batch success but empty map
func (m *mockBPReminderStoreFallback) BatchGetBPReminderStates(userIDs []int64) (map[int64]*store.BPReminderState, error) {
	return make(map[int64]*store.BPReminderState), nil
}
func (m *mockBPReminderStoreFallback) BatchGetLastBPReadings(ctx context.Context, userIDs []int64) (map[int64]*store.BloodPressure, error) {
	return make(map[int64]*store.BloodPressure), nil
}

type mockNotifierFallback struct {
	sent int
}
func (m *mockNotifierFallback) Send(ctx context.Context, userID int64, n notifier.Notification) (int, error) { m.sent++; return 1, nil }
func (m *mockNotifierFallback) Update(ctx context.Context, userID int64, messageID int, n notifier.Notification) error { return nil }
func (m *mockNotifierFallback) CloseNotification(ctx context.Context, userID int64, id string) error { return nil }
func (m *mockNotifierFallback) Delete(ctx context.Context, userID int64, messageID int) error { return nil }

func TestBPReminderChecker_Check_BatchFallback(t *testing.T) {
	now := time.Now()
	// Create state that triggers a notification
	s := &store.BPReminderState{
		UserID: 1,
		Enabled: true,
		PreferredReminderHour: now.Hour(), // Trigger now
	}

	users := []int64{1}
	st := &mockBPReminderStoreFallback{
		users: users,
		states: map[int64]*store.BPReminderState{1: s},
		reads: map[int64]*store.BloodPressure{1: {MeasuredAt: now.Add(-24 * time.Hour)}},
	}
	nt := &mockNotifierFallback{}
	c := &BPReminderChecker{
		store: st,
		notifiers: []notifier.Notifier{nt},
		now: func() time.Time { return now },
	}

	err := c.Check(context.Background())
	assert.NoError(t, err)
	assert.Equal(t, 1, nt.sent, "Notification should be sent due to fallback lookups")
}
