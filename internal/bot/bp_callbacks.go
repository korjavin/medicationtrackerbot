package bot

import (
	"fmt"
	"log"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// SendBPReminderNotification sends a BP reminder notification with action buttons
func (b *Bot) SendBPReminderNotification(userID int64, enhanced bool) (int, error) {
	text := "📊 **Time to measure your blood pressure**\n\n"
	if enhanced {
		text += "⚠️ Your recent readings have been higher than usual. Regular monitoring is important.\n\n"
	}
	text += "Please take a moment to measure and record your BP."

	// Create inline keyboard with three buttons
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Confirm", "bp_confirm"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏰ Snooze (2h)", "bp_snooze"),
			tgbotapi.NewInlineKeyboardButtonData("🔇 Don't Bug Me (24h)", "bp_dontbug"),
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

// handleBPReminderCallback handles callbacks from BP reminder buttons
func (b *Bot) handleBPReminderCallback(cb *tgbotapi.CallbackQuery, data string) {
	switch data {
	case "bp_confirm":
		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		// Send instruction message
		var webAppURL string
		if b.appDomain != "" {
			domain := b.appDomain
			if !strings.HasPrefix(domain, "http") {
				domain = "https://" + domain
			}
			webAppURL = fmt.Sprintf("%s/bp_add", domain) // Keep direct link for web app
		} else {
			webAppURL = fmt.Sprintf("https://t.me/%s/app?startapp=bp_add", b.Username())
		}

		msg := tgbotapi.NewMessage(cb.Message.Chat.ID,
			"📱 Please open the app to record your blood pressure reading:\n\n"+
				"[Open App to Add BP Reading]("+webAppURL+")")
		msg.ParseMode = "Markdown"
		if _, err := b.api.Send(msg); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

	case "bp_snooze":
		// Snooze for 2 hours
		if err := b.reminderSvc.SnoozeBPReminder(cb.From.ID); err != nil {
			log.Printf("Error snoozing BP reminder: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing reminder.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		// Delete the notification
		deleteMsg := tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)
		if _, err := b.api.Send(deleteMsg); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		// Send confirmation
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⏰ BP reminder snoozed for 2 hours.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

	case "bp_dontbug":
		// Block for 24 hours
		if err := b.reminderSvc.BlockBPReminders(cb.From.ID); err != nil {
			log.Printf("Error setting don't bug me for BP reminder: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error blocking reminders.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		// Delete the notification
		deleteMsg := tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)
		if _, err := b.api.Send(deleteMsg); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		// Send confirmation
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "🔇 BP reminders disabled for 24 hours.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	}
}
