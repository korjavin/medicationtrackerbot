package bot

import (
	"fmt"
	"log/slog"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/tzlookup"
)

// TimezoneStore is the subset of store operations needed for timezone bot commands.
type TimezoneStore interface {
	GetCurrentTimezone() (string, error)
	RecordTimezone(tz string) error
}

// handleTZCommand handles the /tz command by sending a location request keyboard.
func (b *Bot) handleTZCommand(chatID int64) {
	btn := tgbotapi.KeyboardButton{
		Text:            "Share my location",
		RequestLocation: true,
	}
	markup := tgbotapi.NewReplyKeyboard(tgbotapi.NewKeyboardButtonRow(btn))
	markup.OneTimeKeyboard = true
	markup.ResizeKeyboard = true

	msg := tgbotapi.NewMessage(chatID, "Please share your location so I can detect your timezone. Your workout, BP, and weight reminders will be adjusted. Medication times are not affected.")
	msg.ReplyMarkup = markup

	if _, err := b.api.Send(msg); err != nil {
		slog.Error("send failed", "error", err)
	}
}

// handleLocationMessage handles an incoming location message, looks up the timezone,
// records it in the store, and sends a confirmation.
func (b *Bot) handleLocationMessage(msg *tgbotapi.Message) {
	loc := msg.Location
	tz, err := tzlookup.LookupTimezone(loc.Latitude, loc.Longitude)
	if err != nil {
		slog.Error("timezone lookup failed", "lat", loc.Latitude, "lng", loc.Longitude, "error", err)
		reply := tgbotapi.NewMessage(msg.Chat.ID, "Could not determine timezone from your location. Please try again.")
		reply.ReplyMarkup = tgbotapi.NewRemoveKeyboard(true)
		if _, err := b.api.Send(reply); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	if err := b.timezone.RecordTimezone(tz); err != nil {
		slog.Error("RecordTimezone failed", "tz", tz, "error", err)
		reply := tgbotapi.NewMessage(msg.Chat.ID, "Error saving timezone. Please try again.")
		reply.ReplyMarkup = tgbotapi.NewRemoveKeyboard(true)
		if _, err := b.api.Send(reply); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	reply := tgbotapi.NewMessage(msg.Chat.ID, fmt.Sprintf(
		"Timezone set to %s. Your workout, BP, and weight reminders are now adjusted. Note: medication times are not affected.",
		tz,
	))
	reply.ReplyMarkup = tgbotapi.NewRemoveKeyboard(true)
	if _, err := b.api.Send(reply); err != nil {
		slog.Error("send failed", "error", err)
	}
}
