package bot

import (
	"fmt"
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
	case "help":
		msgConfig.Text = `**Medication Tracker Bot** allows you to track your medications.

**Commands:**
/start - Start the bot and open the Mini App.
/log - Manually log a dose for any medication (useful for "As Needed" meds).
/help - Show this help message.

**How to use:**
1. Click the "Menu" button to open the App.
2. Add your medications and set schedules.
3. The bot will notify you when it's time to take them.
4. Click "Confirm" on the notification to log usage.`
		msgConfig.ParseMode = "Markdown"
	case "log":
		// Fetch active medications
		meds, err := b.store.ListMedications(false)
		if err != nil {
			msgConfig.Text = "Error fetching medications."
			break
		}
		if len(meds) == 0 {
			msgConfig.Text = "No medications found. Use the App to add some first."
			break
		}

		var rows [][]tgbotapi.InlineKeyboardButton
		for _, m := range meds {
			callbackData := "log:" + strconv.FormatInt(m.ID, 10)
			btn := tgbotapi.NewInlineKeyboardButtonData("Take "+m.Name, callbackData)
			rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
		}

		msgConfig.Text = "Select medication to log:"
		msgConfig.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	default:
		msgConfig.Text = "Unknown command. Try /help."
	}

	b.api.Send(msgConfig)
}

func (b *Bot) handleCallback(cb *tgbotapi.CallbackQuery) {
	callbackCfg := tgbotapi.NewCallback(cb.ID, "")
	b.api.Request(callbackCfg)

	data := cb.Data
	// data format: "confirm:<medID>", "confirm_schedule:<unix>", or "log:<medID>"
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
	} else if len(data) > 4 && data[:4] == "log:" {
		medIDStr := data[4:]
		medID, _ := strconv.ParseInt(medIDStr, 10, 64)

		// Create Intake record (Taken Now)
		now := time.Now()
		logID, err := b.store.CreateIntake(medID, b.allowedUserID, now)
		if err != nil {
			log.Printf("Error creating manual intake: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging medication."))
			return
		}

		// Confirm immediately
		if err := b.store.ConfirmIntake(logID, now); err != nil {
			log.Printf("Error confirming manual intake: %v", err)
			return
		}

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Fetch med name for confirmation
		med, _ := b.store.GetMedication(medID) // Error ignored, just for display
		medName := "Medication"
		if med != nil {
			medName = med.Name
		}

		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, fmt.Sprintf("✅ Logged %s at %s", medName, now.Format("15:04"))))

	} else if len(data) > 17 && data[:17] == "confirm_schedule:" {
		tsStr := data[17:]
		ts, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			return
		}

		target := time.Unix(ts, 0)

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
	sb = fmt.Sprintf("💊 Time to take your medications (%s):\n\n", target.Format("15:04"))
	for _, m := range meds {
		if m.Dosage != "" {
			sb += fmt.Sprintf("- %s (%s)\n", m.Name, m.Dosage)
		} else {
			sb += fmt.Sprintf("- %s\n", m.Name)
		}
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
