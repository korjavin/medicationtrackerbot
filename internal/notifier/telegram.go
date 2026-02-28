package notifier

import "context"

// TelegramSender abstracts the Telegram message operations needed by the notifier.
type TelegramSender interface {
	SendMarkdownNotification(text string, actions []struct{ ID, Label string }) (int, error)
	DeleteMessage(messageID int) error
}

// Telegram implements Notifier by delegating to a TelegramSender.
type Telegram struct {
	bot TelegramSender
}

// NewTelegram creates a Notifier that sends via Telegram.
func NewTelegram(b TelegramSender) *Telegram {
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
