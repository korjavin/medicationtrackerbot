package bot

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/tzlookup"
)

// TimezoneStore is the subset of store operations needed for timezone bot commands.
type TimezoneStore interface {
	GetCurrentTimezone() (string, error)
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

	msg := tgbotapi.NewMessage(chatID, "Please share your location so I can detect your timezone. Your workout, BP, and weight reminders will be adjusted. If your timezone changed, I'll send a separate transition plan you can approve or reject to control when medication times shift.")
	msg.ReplyMarkup = markup

	if _, err := b.api.Send(msg); err != nil {
		slog.Error("send failed", "error", err)
		return
	}

	b.awaitingLocationMu.Lock()
	b.awaitingLocationChatID = chatID
	b.awaitingLocationExpiry = time.Now().Add(5 * time.Minute)
	b.awaitingLocationMu.Unlock()
}

// handleLocationMessage handles an incoming location message, looks up the timezone,
// records it in the store, and sends a confirmation.
// It only processes the location if the user previously invoked /tz; other location
// messages (forwarded locations, future features) are silently ignored.
func (b *Bot) handleLocationMessage(msg *tgbotapi.Message) {
	b.awaitingLocationMu.Lock()
	awaiting := b.awaitingLocationChatID != 0 &&
		msg.Chat.ID == b.awaitingLocationChatID &&
		time.Now().Before(b.awaitingLocationExpiry)
	if awaiting {
		b.awaitingLocationChatID = 0
		b.awaitingLocationExpiry = time.Time{}
	}
	b.awaitingLocationMu.Unlock()

	if !awaiting {
		return
	}

	// restoreAwaiting puts the pending state back so a follow-up location share is
	// accepted without the user having to run /tz again.
	restoreAwaiting := func() {
		b.awaitingLocationMu.Lock()
		b.awaitingLocationChatID = msg.Chat.ID
		b.awaitingLocationExpiry = time.Now().Add(5 * time.Minute)
		b.awaitingLocationMu.Unlock()
	}

	loc := msg.Location
	tz, err := tzlookup.LookupTimezone(loc.Latitude, loc.Longitude)
	if err != nil {
		slog.Error("timezone lookup failed", "error", err)
		restoreAwaiting()
		reply := tgbotapi.NewMessage(msg.Chat.ID, "Could not determine timezone from your location. Please try again.")
		if _, err := b.api.Send(reply); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	if _, err := time.LoadLocation(tz); err != nil {
		slog.Error("invalid timezone from lookup", "tz", tz, "error", err)
		restoreAwaiting()
		reply := tgbotapi.NewMessage(msg.Chat.ID, "Could not determine timezone from your location. Please try again.")
		if _, err := b.api.Send(reply); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	result, err := b.tzUpdater.UpdateTimezone(context.Background(), tz)
	if err != nil {
		slog.Error("UpdateTimezone failed", "tz", tz, "error", err)
		restoreAwaiting()
		reply := tgbotapi.NewMessage(msg.Chat.ID, "Error saving timezone. Please try again.")
		if _, err := b.api.Send(reply); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	var body string
	if result.PlanCreated {
		body = fmt.Sprintf(
			"Timezone set to %s. Workout, BP, and weight reminders are adjusted. I'll send a separate transition plan for your medication times — approve or reject it to control when doses shift.",
			tz,
		)
	} else {
		body = fmt.Sprintf(
			"Timezone set to %s. Workout, BP, and weight reminders are adjusted.",
			tz,
		)
	}
	reply := tgbotapi.NewMessage(msg.Chat.ID, body)
	reply.ReplyMarkup = tgbotapi.NewRemoveKeyboard(true)
	if _, err := b.api.Send(reply); err != nil {
		slog.Error("send failed", "error", err)
	}
}
