package scheduler

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

type mockHelperNotifier struct {
	mu           sync.Mutex
	sendCalls    int
	deleteCalls  int
	sendMsgID    int
	sendErr      error
	deleteErr    error
	deletedMsgID int

	sendCh   chan struct{}
	deleteCh chan struct{}
}

func (m *mockHelperNotifier) Send(ctx context.Context, userID int64, n notifier.Notification) (int, error) {
	m.mu.Lock()
	m.sendCalls++
	m.mu.Unlock()

	if m.sendCh != nil {
		m.sendCh <- struct{}{}
	}
	return m.sendMsgID, m.sendErr
}

func (m *mockHelperNotifier) Delete(ctx context.Context, userID int64, msgID int) error {
	m.mu.Lock()
	m.deleteCalls++
	m.deletedMsgID = msgID
	m.mu.Unlock()

	if m.deleteCh != nil {
		m.deleteCh <- struct{}{}
	}
	return m.deleteErr
}

func (m *mockHelperNotifier) CloseNotification(ctx context.Context, userID int64, tag string) error {
	return nil
}

func TestNotifyHelper_Notify(t *testing.T) {
	m1 := &mockHelperNotifier{sendMsgID: 10, sendCh: make(chan struct{}, 1)}
	m2 := &mockHelperNotifier{sendErr: errors.New("fail"), sendCh: make(chan struct{}, 1)}
	h := &NotifyHelper{
		notifiers:     []notifier.Notifier{m1, m2},
		allowedUserID: 123,
	}

	storedCh := make(chan int, 1)
	storeFunc := func(id int) {
		storedCh <- id
	}

	h.Notify(context.Background(), notifier.Notification{}, storeFunc)

	// Wait for storeFunc to be called
	select {
	case id := <-storedCh:
		if id != 10 {
			t.Errorf("storedMsgID = %d, want 10", id)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for storeFunc")
	}

	// Wait for m2 to finish sending
	select {
	case <-m2.sendCh:
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for m2 send")
	}

	m2.mu.Lock()
	if m2.sendCalls != 1 {
		t.Errorf("m2 send calls = %d, want 1", m2.sendCalls)
	}
	m2.mu.Unlock()
}

func TestNotifyHelper_NotifySync_Success(t *testing.T) {
	m1 := &mockHelperNotifier{sendMsgID: 10}
	m2 := &mockHelperNotifier{sendMsgID: 20}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1, m2}}

	var stored []int
	storeFunc := func(id int) {
		stored = append(stored, id)
	}

	err := h.NotifySync(context.Background(), notifier.Notification{}, storeFunc)
	if err != nil {
		t.Errorf("NotifySync returned err: %v", err)
	}

	if len(stored) != 2 || stored[0] != 10 || stored[1] != 20 {
		t.Errorf("storedMsgIDs = %v, want [10, 20]", stored)
	}
}

func TestNotifyHelper_NotifySync_PartialFailure(t *testing.T) {
	m1 := &mockHelperNotifier{sendErr: errors.New("fail")}
	m2 := &mockHelperNotifier{sendMsgID: 20}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1, m2}}

	var stored []int
	storeFunc := func(id int) {
		stored = append(stored, id)
	}

	err := h.NotifySync(context.Background(), notifier.Notification{}, storeFunc)
	if err != nil {
		t.Errorf("NotifySync returned err: %v, want nil", err)
	}

	if len(stored) != 1 || stored[0] != 20 {
		t.Errorf("storedMsgIDs = %v, want [20]", stored)
	}
}

func TestNotifyHelper_NotifySync_AllNoChannel(t *testing.T) {
	m1 := &mockHelperNotifier{sendErr: notifier.ErrNoDeliveryChannel}
	m2 := &mockHelperNotifier{sendErr: notifier.ErrNoDeliveryChannel}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1, m2}}

	err := h.NotifySync(context.Background(), notifier.Notification{}, nil)
	if !errors.Is(err, notifier.ErrNoDeliveryChannel) {
		t.Errorf("NotifySync returned %v, want ErrNoDeliveryChannel", err)
	}
}

func TestNotifyHelper_NotifySync_TransientError(t *testing.T) {
	transientErr := errors.New("network error")
	m1 := &mockHelperNotifier{sendErr: notifier.ErrNoDeliveryChannel}
	m2 := &mockHelperNotifier{sendErr: transientErr}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1, m2}}

	err := h.NotifySync(context.Background(), notifier.Notification{}, nil)
	if !errors.Is(err, transientErr) {
		t.Errorf("NotifySync returned %v, want %v", err, transientErr)
	}
}

func TestNotifyHelper_DeleteNotification(t *testing.T) {
	m1 := &mockHelperNotifier{deleteCh: make(chan struct{}, 1)}
	m2 := &mockHelperNotifier{deleteCh: make(chan struct{}, 1)}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1, m2}}

	// Test zero ID - shouldn't call delete
	h.DeleteNotification(context.Background(), 0)
	time.Sleep(10 * time.Millisecond) // Give goroutines a chance if they were incorrectly spawned
	m1.mu.Lock()
	if m1.deleteCalls != 0 {
		t.Errorf("expected 0 delete calls for zero msgID, got %d", m1.deleteCalls)
	}
	m1.mu.Unlock()

	// Test valid ID
	h.DeleteNotification(context.Background(), 42)

	// Wait for async deletes
	for _, m := range []*mockHelperNotifier{m1, m2} {
		select {
		case <-m.deleteCh:
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for delete call")
		}
	}

	m1.mu.Lock()
	if m1.deleteCalls != 1 {
		t.Errorf("m1 delete calls = %d, want 1", m1.deleteCalls)
	}
	if m1.deletedMsgID != 42 {
		t.Errorf("m1 deletedMsgID = %d, want 42", m1.deletedMsgID)
	}
	m1.mu.Unlock()

	m2.mu.Lock()
	if m2.deleteCalls != 1 {
		t.Errorf("m2 delete calls = %d, want 1", m2.deleteCalls)
	}
	if m2.deletedMsgID != 42 {
		t.Errorf("m2 deletedMsgID = %d, want 42", m2.deletedMsgID)
	}
	m2.mu.Unlock()
}

func TestNotifyHelper_DeleteNotification_Error(t *testing.T) {
	m1 := &mockHelperNotifier{
		deleteErr: errors.New("delete failed"),
		deleteCh:  make(chan struct{}, 1),
	}
	h := &NotifyHelper{notifiers: []notifier.Notifier{m1}}

	h.DeleteNotification(context.Background(), 42)

	select {
	case <-m1.deleteCh:
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for delete call")
	}

	m1.mu.Lock()
	if m1.deleteCalls != 1 {
		t.Errorf("m1 delete calls = %d, want 1", m1.deleteCalls)
	}
	m1.mu.Unlock()
}
