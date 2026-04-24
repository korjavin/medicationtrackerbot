package bot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockNotesService struct {
	created []*store.DiaryNote
	err     error
}

func (m *mockNotesService) CreateNote(ctx context.Context, userID int64, content string, tag *string) (*store.DiaryNote, error) {
	if m.err != nil {
		return nil, m.err
	}
	n := &store.DiaryNote{ID: 1, UserID: userID, Content: content, Tag: tag}
	m.created = append(m.created, n)
	return n, nil
}

func (m *mockNotesService) ListNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error) {
	return nil, nil
}

func (m *mockNotesService) DeleteNote(ctx context.Context, userID, noteID int64) error {
	return nil
}

func TestHandleNoteCommand_Success(t *testing.T) {
	ms := &mockNotesService{}
	b := &Bot{notesSvc: ms, allowedUserID: 123}

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
	if ms.created[0].Tag != nil {
		t.Errorf("Expected nil tag for /note, got %v", *ms.created[0].Tag)
	}
}

func TestHandleNoteCommand_NoArgs(t *testing.T) {
	ms := &mockNotesService{}
	b := &Bot{notesSvc: ms, allowedUserID: 123}

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
	ms := &mockNotesService{err: domain.ErrContentTooLong}
	b := &Bot{notesSvc: ms, allowedUserID: 123}

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
}

func TestHandleNoteCommand_StoreError(t *testing.T) {
	ms := &mockNotesService{err: errors.New("db error")}
	b := &Bot{notesSvc: ms, allowedUserID: 123}

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
