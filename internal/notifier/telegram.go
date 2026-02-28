package notifier

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
)

// Telegram implements Notifier by delegating to *bot.Bot.
type Telegram struct {
	bot *bot.Bot
}

// NewTelegram creates a Notifier that sends via Telegram.
func NewTelegram(b *bot.Bot) *Telegram {
	return &Telegram{bot: b}
}

func (t *Telegram) Send(_ context.Context, _ int64, n Notification) (int, error) {
	actions := make([]struct{ ID, Label string }, len(n.Actions))
	for i, a := range n.Actions {
		actions[i] = struct{ ID, Label string }{ID: a.ID, Label: a.Label}
	}
	return t.bot.SendMarkdownNotification(n.Text, actions)
}

func (t *Telegram) Delete(_ context.Context, _ int64, msgID int) error {
	if msgID == 0 {
		return nil
	}
	return t.bot.DeleteMessage(msgID)
}
