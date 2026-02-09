package bot

import (
	"fmt"
	"log"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// SendWeightReminderNotification sends a weight reminder notification with action buttons
func (b *Bot) SendWeightReminderNotification(userID int64) (int, error) {
	text := "⚖️ **Time to track your weight**\n\n"
	text += "It's been about a week since your last measurement. "
	text += "Regular tracking helps you stay on top of your goals!"

	// Create inline keyboard with three buttons
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Confirm", "weight_confirm"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏰ Snooze (2h)", "weight_snooze"),
			tgbotapi.NewInlineKeyboardButtonData("🔇 Don't Bug Me (24h)", "weight_dontbug"),
		),
	)

	msg := tgbotapi.NewMessage(userID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sent, err := b.api.Send(msg)
	if err != nil {
		return 0, err
	}

	return sent.MessageID, nil
}

// handleWeightReminderCallback handles callbacks from weight reminder buttons
func (b *Bot) handleWeightReminderCallback(cb *tgbotapi.CallbackQuery, data string) {
	switch data {
	case "weight_confirm":
		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Send instruction message with deep link
		webAppURL := fmt.Sprintf("https://t.me/%s/app?startapp=weight_add", b.Username())
		msg := tgbotapi.NewMessage(cb.Message.Chat.ID,
			"📱 Please open the app to log your weight:\n\n"+
				"[Open App to Add Weight]("+webAppURL+")")
		msg.ParseMode = "Markdown"
		b.api.Send(msg)

	case "weight_snooze":
		// Snooze for 2 hours
		if err := b.store.SnoozeWeightReminder(cb.From.ID); err != nil {
			log.Printf("Error snoozing weight reminder: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing reminder."))
			return
		}

		// Delete the notification
		deleteMsg := tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)
		b.api.Send(deleteMsg)

		// Send confirmation
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⏰ Weight reminder snoozed for 2 hours."))

	case "weight_dontbug":
		// Block for 24 hours
		if err := b.store.DontBugMeWeightReminder(cb.From.ID); err != nil {
			log.Printf("Error setting don't bug me for weight reminder: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error blocking reminders."))
			return
		}

		// Delete the notification
		deleteMsg := tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)
		b.api.Send(deleteMsg)

		// Send confirmation
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "🔇 Weight reminders disabled for 24 hours."))
	}
}
