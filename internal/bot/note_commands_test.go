package bot

import (
	"context"
	"errors"
	"strings"
	"testing"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockNoteStore struct {
	NoteStore
	created []*store.DiaryNote
	err     error
}

func (m *mockNoteStore) CreateDiaryNote(ctx context.Context, userID int64, content string) (*store.DiaryNote, error) {
	if m.err != nil {
		return nil, m.err
	}
	note := &store.DiaryNote{ID: 1, UserID: userID, Content: content}
	m.created = append(m.created, note)
	return note, nil
}

func TestHandleNoteCommand_Success(t *testing.T) {
	ms := &mockNoteStore{}
	b := &Bot{notes: ms, allowedUserID: 123}

	msg := &tgbotapi.Message{
		Text: "/note Feeling great today",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleNoteCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Note saved") {
		t.Errorf("Expected 'Note saved', got %q", msgConfig.Text)
	}
	if len(ms.created) != 1 {
		t.Fatalf("Expected 1 note created, got %d", len(ms.created))
	}
	if ms.created[0].Content != "Feeling great today" {
		t.Errorf("Expected content 'Feeling great today', got %q", ms.created[0].Content)
	}
}

func TestHandleNoteCommand_NoArgs(t *testing.T) {
	ms := &mockNoteStore{}
	b := &Bot{notes: ms, allowedUserID: 123}

	msg := &tgbotapi.Message{
		Text: "/note",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleNoteCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Usage:") {
		t.Errorf("Expected usage text, got %q", msgConfig.Text)
	}
	if len(ms.created) != 0 {
		t.Errorf("Expected 0 notes created, got %d", len(ms.created))
	}
}

func TestHandleNoteCommand_TooLong(t *testing.T) {
	ms := &mockNoteStore{}
	b := &Bot{notes: ms, allowedUserID: 123}

	msg := &tgbotapi.Message{
		Text: "/note " + strings.Repeat("x", 10001),
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleNoteCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "too long") {
		t.Errorf("Expected 'too long' message, got %q", msgConfig.Text)
	}
	if len(ms.created) != 0 {
		t.Errorf("Expected 0 notes created, got %d", len(ms.created))
	}
}

func TestHandleNoteCommand_StoreError(t *testing.T) {
	ms := &mockNoteStore{err: errors.New("db error")}
	b := &Bot{notes: ms, allowedUserID: 123}

	msg := &tgbotapi.Message{
		Text: "/note test",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleNoteCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Error") {
		t.Errorf("Expected error message, got %q", msgConfig.Text)
	}
}
