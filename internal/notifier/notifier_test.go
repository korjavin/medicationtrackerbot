package notifier

import (
	"context"
	"testing"
)

func TestStripMarkdown_Bold(t *testing.T) {
	input := "**Hello** world"
	want := "Hello world"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestStripMarkdown_MultipleBold(t *testing.T) {
	input := "**Hello** and **world**"
	want := "Hello and world"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestStripMarkdown_Italic(t *testing.T) {
	input := "*italic text*"
	want := "italic text"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestStripMarkdown_InlineCode(t *testing.T) {
	input := "run `go test` now"
	want := "run go test now"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestStripMarkdown_Mixed(t *testing.T) {
	input := "**Bold** and *italic* and `code`"
	want := "Bold and italic and code"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestStripMarkdown_NoMarkdown(t *testing.T) {
	input := "plain text without formatting"
	got := StripMarkdown(input)
	if got != input {
		t.Errorf("StripMarkdown(%q) = %q, want unchanged", input, got)
	}
}

func TestStripMarkdown_Empty(t *testing.T) {
	got := StripMarkdown("")
	if got != "" {
		t.Errorf("StripMarkdown(\"\") = %q, want empty", got)
	}
}

func TestStripMarkdown_EmojiPreserved(t *testing.T) {
	input := "💊 **Medication** time"
	want := "💊 Medication time"
	got := StripMarkdown(input)
	if got != want {
		t.Errorf("StripMarkdown(%q) = %q, want %q", input, got, want)
	}
}

func TestFirstLine_SingleLine(t *testing.T) {
	got := firstLine("hello world")
	if got != "hello world" {
		t.Errorf("firstLine single = %q, want %q", got, "hello world")
	}
}

func TestFirstLine_MultiLine(t *testing.T) {
	got := firstLine("first line\nsecond line\nthird")
	if got != "first line" {
		t.Errorf("firstLine multi = %q, want %q", got, "first line")
	}
}

func TestFirstLine_Empty(t *testing.T) {
	got := firstLine("")
	if got != "" {
		t.Errorf("firstLine empty = %q, want empty", got)
	}
}

func TestFirstLine_LeadingNewline(t *testing.T) {
	got := firstLine("\nrest")
	if got != "" {
		t.Errorf("firstLine leading newline = %q, want empty", got)
	}
}

// MockNotifier is a test double for the Notifier interface.
type MockNotifier struct {
	SendCalls   []SendCall
	DeleteCalls []DeleteCall
	SendMsgID   int
	SendErr     error
	DeleteErr   error
}

type SendCall struct {
	UserID       int64
	Notification Notification
}

type DeleteCall struct {
	UserID int64
	MsgID  int
}

func (m *MockNotifier) Send(_ context.Context, userID int64, n Notification) (int, error) {
	m.SendCalls = append(m.SendCalls, SendCall{UserID: userID, Notification: n})
	return m.SendMsgID, m.SendErr
}

func (m *MockNotifier) Delete(_ context.Context, userID int64, msgID int) error {
	m.DeleteCalls = append(m.DeleteCalls, DeleteCall{UserID: userID, MsgID: msgID})
	return m.DeleteErr
}

func TestMockNotifier_ImplementsInterface(t *testing.T) {
	// Compile-time check that MockNotifier satisfies Notifier
	var _ Notifier = &MockNotifier{}
}

func TestMockNotifier_SendRecordsCalls(t *testing.T) {
	m := &MockNotifier{SendMsgID: 42}
	n := Notification{
		Text:    "test message",
		Actions: []Action{{ID: "action1", Label: "Button"}},
		Tag:     "test-tag",
	}

	msgID, err := m.Send(context.Background(), 123, n)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msgID != 42 {
		t.Errorf("msgID = %d, want 42", msgID)
	}
	if len(m.SendCalls) != 1 {
		t.Fatalf("expected 1 send call, got %d", len(m.SendCalls))
	}
	if m.SendCalls[0].UserID != 123 {
		t.Errorf("userID = %d, want 123", m.SendCalls[0].UserID)
	}
	if m.SendCalls[0].Notification.Text != "test message" {
		t.Errorf("text = %q, want %q", m.SendCalls[0].Notification.Text, "test message")
	}
	if m.SendCalls[0].Notification.Tag != "test-tag" {
		t.Errorf("tag = %q, want %q", m.SendCalls[0].Notification.Tag, "test-tag")
	}
}

func TestMockNotifier_DeleteRecordsCalls(t *testing.T) {
	m := &MockNotifier{}
	err := m.Delete(context.Background(), 123, 456)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(m.DeleteCalls) != 1 {
		t.Fatalf("expected 1 delete call, got %d", len(m.DeleteCalls))
	}
	if m.DeleteCalls[0].UserID != 123 {
		t.Errorf("userID = %d, want 123", m.DeleteCalls[0].UserID)
	}
	if m.DeleteCalls[0].MsgID != 456 {
		t.Errorf("msgID = %d, want 456", m.DeleteCalls[0].MsgID)
	}
}
