package bot

import (
	"context"
	"strings"
	"unicode/utf8"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// NoteStore is the subset of store operations needed for note bot commands.
type NoteStore interface {
	CreateDiaryNote(ctx context.Context, userID int64, content string) (*store.DiaryNote, error)
}

// handleNoteCommand handles the /note command.
// Format: /note <text>
func (b *Bot) handleNoteCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := strings.TrimSpace(msg.CommandArguments())
	if args == "" {
		msgConfig.Text = "Usage: /note <text>\nExample: /note Feeling tired today"
		return
	}
	if utf8.RuneCountInString(args) > 10000 {
		msgConfig.Text = "❌ Note is too long (max 10,000 characters)."
		return
	}

	_, err := b.notes.CreateDiaryNote(context.Background(), b.allowedUserID, args)
	if err != nil {
		msgConfig.Text = "❌ Error saving note."
		return
	}

	msgConfig.Text = "✅ Note saved."
}
