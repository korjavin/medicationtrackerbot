package bot

import (
	"context"
	"errors"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
)

// handleNoteCommand handles the /note command.
// Format: /note <text>
func (b *Bot) handleNoteCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := strings.TrimSpace(msg.CommandArguments())
	if args == "" {
		msgConfig.Text = "Usage: /note <text>\nExample: /note Feeling tired today"
		return
	}

	_, err := b.notesSvc.CreateNote(context.Background(), b.allowedUserID, args, nil)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrContentTooLong):
			msgConfig.Text = "❌ Note is too long (max 10,000 characters)."
		case errors.Is(err, domain.ErrEmptyContent):
			msgConfig.Text = "Usage: /note <text>\nExample: /note Feeling tired today"
		default:
			msgConfig.Text = "❌ Error saving note."
		}
		return
	}

	msgConfig.Text = "✅ Note saved."
}
