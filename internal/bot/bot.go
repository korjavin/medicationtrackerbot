package bot

import (
	"log"
	"strconv"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type Bot struct {
	api           *tgbotapi.BotAPI
	store         *store.Store
	allowedUserID int64
}

func New(token string, allowedUserID int64, s *store.Store) (*Bot, error) {
	api, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		return nil, err
	}

	return &Bot{
		api:           api,
		store:         s,
		allowedUserID: allowedUserID,
	}, nil
}

func (b *Bot) Start() {
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60

	updates := b.api.GetUpdatesChan(u)

	for update := range updates {
		if update.Message == nil && update.CallbackQuery == nil {
			continue
		}

		var fromID int64
		if update.Message != nil {
			fromID = update.Message.From.ID
		} else if update.CallbackQuery != nil {
			fromID = update.CallbackQuery.From.ID
		}

		if fromID != b.allowedUserID {
			log.Printf("Ignoring update from unauthorized user: %d", fromID)
			continue
		}

		if update.Message != nil {
			b.handleMessage(update.Message)
		} else if update.CallbackQuery != nil {
			b.handleCallback(update.CallbackQuery)
		}
	}
}

func (b *Bot) handleMessage(msg *tgbotapi.Message) {
	if !msg.IsCommand() {
		return
	}

	msgConfig := tgbotapi.NewMessage(msg.Chat.ID, "")
	switch msg.Command() {
	case "start":
		msgConfig.Text = "Welcome! Use the Mini App to manage your medications."
		// TODO: Configure actual URL from ENV if needed, or user can assume it's set in BotFather.
		// Usually WebApp button is set up in BotFather menu, but we can provide keyboard too.
		// For now keeping placeholder.
		/*
			webApp := tgbotapi.WebAppInfo{URL: "https://your-domain.com"}
			btn := tgbotapi.KeyboardButton{Text: "Open App", WebApp: &webApp}
			row := tgbotapi.NewKeyboardButtonRow(btn)
			keyboard := tgbotapi.NewReplyKeyboard(row)
			msgConfig.ReplyMarkup = keyboard
		*/
	default:
		msgConfig.Text = "Unknown command."
	}

	b.api.Send(msgConfig)
}

func (b *Bot) handleCallback(cb *tgbotapi.CallbackQuery) {
	callbackCfg := tgbotapi.NewCallback(cb.ID, "")
	b.api.Request(callbackCfg)

	data := cb.Data
	// data format: "confirm:<medID>" or "confirm_schedule:<unix>"
	if len(data) > 8 && data[:8] == "confirm:" {
		medIDStr := data[8:]
		medID, _ := strconv.ParseInt(medIDStr, 10, 64)

		// Find pending intake
		pending, err := b.store.GetPendingIntakes()
		if err != nil {
			log.Printf("Error getting pending: %v", err)
			return
		}

		var logID int64
		for _, p := range pending {
			if p.MedicationID == medID {
				logID = p.ID
				break
			}
		}

		if logID != 0 {
			if err := b.store.ConfirmIntake(logID, time.Now()); err != nil {
				log.Printf("Error configuring intake: %v", err)
				return
			}

			// Remove button
			edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
				InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
			})
			b.api.Send(edit)

			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "✅ Marked as taken."))
		} else {
			// Maybe it was already taken?
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⚠️ No pending intake found (or already taken)."))
		}
	} else if len(data) > 17 && data[:17] == "confirm_schedule:" {
		tsStr := data[17:]
		ts, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			return
		}

		target := time.Unix(ts, 0)
		// Note: Unix() returns Local time? No, it returns UTC Unix Seconds.
		// time.Unix() converts to Local by default in Go's display, but standard time.
		// We need to match what we stored.
		// Store stores the Time object.

		if err := b.store.ConfirmIntakesBySchedule(b.allowedUserID, target, time.Now()); err != nil {
			log.Printf("Error confirming batch: %v", err)
			return
		}

		// Update message to remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "✅ All medications for this time marked as taken."))
	}
}

func (b *Bot) SendNotification(text string, medicationID int64) error {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)

	// Add Confirm Button
	// Passing medicationID in callback data: "confirm:<id>"
	data := "confirm:" + strconv.FormatInt(medicationID, 10)
	btn := tgbotapi.NewInlineKeyboardButtonData("✅ Confirm Intake", data)
	row := tgbotapi.NewInlineKeyboardRow(btn)
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(row)

	_, err := b.api.Send(msg)
	return err
}

func (b *Bot) SendGroupNotification(meds []store.Medication, target time.Time) error {
	var sb string
	sb = "💊 Time to take your medications:\n\n"
	for _, m := range meds {
		sb += "- " + m.Name + " (" + m.Dosage + ")\n"
	}

	msg := tgbotapi.NewMessage(b.allowedUserID, sb)

	var rows [][]tgbotapi.InlineKeyboardButton

	// 1. Individual Buttons
	for _, m := range meds {
		data := "confirm:" + strconv.FormatInt(m.ID, 10)
		btn := tgbotapi.NewInlineKeyboardButtonData("Take "+m.Name, data) // Shorten text
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	// 2. Confirm All Button
	// Key: "confirm_schedule:<unix_timestamp>"
	data := "confirm_schedule:" + strconv.FormatInt(target.Unix(), 10)
	btn := tgbotapi.NewInlineKeyboardButtonData("✅✅ Confirm ALL", data)
	rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))

	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)

	_, err := b.api.Send(msg)
	return err
}
