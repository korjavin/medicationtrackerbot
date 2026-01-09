package bot

import (
	"bytes"
	"encoding/csv"
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
	case "download":
		rows := [][]tgbotapi.InlineKeyboardButton{
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("Since last download", "download:since_last"),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("Last 7 days", "download:7"),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("Last 14 days", "download:14"),
			),
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("Last 30 days", "download:30"),
			),
		}

		msgConfig.Text = "Select time period for export:"
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
			// Clean up reminders
			reminders, _ := b.store.GetIntakeReminders(logID)
			for _, msgID := range reminders {
				if msgID != cb.Message.MessageID {
					b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID))
				}
			}

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

		// Clean up reminders for all related intakes
		pending, err := b.store.GetPendingIntakesBySchedule(b.allowedUserID, target)
		if err == nil {
			for _, p := range pending {
				reminders, _ := b.store.GetIntakeReminders(p.ID)
				for _, msgID := range reminders {
					if msgID != cb.Message.MessageID {
						b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID))
					}
				}
			}
		}

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
	} else if len(data) > 9 && data[:9] == "download:" {
		option := data[9:]
		b.handleDownloadCallback(cb, option)
	}
}

func (b *Bot) SendNotification(text string, medicationID int64) (int, error) {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)

	// Add Confirm Button
	// Passing medicationID in callback data: "confirm:<id>"
	data := "confirm:" + strconv.FormatInt(medicationID, 10)
	btn := tgbotapi.NewInlineKeyboardButtonData("✅ Confirm Intake", data)
	row := tgbotapi.NewInlineKeyboardRow(btn)
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(row)

	sentMsg, err := b.api.Send(msg)
	return sentMsg.MessageID, err
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

func (b *Bot) handleDownloadCallback(cb *tgbotapi.CallbackQuery, option string) {
	var since time.Time
	switch option {
	case "since_last":
		lastDownload, err := b.store.GetLastDownload()
		if err != nil {
			log.Printf("Error getting last download: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving last download date."))
			return
		}
		if lastDownload.IsZero() {
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "No previous download found. Please choose a time period."))
			return
		}
		since = lastDownload
	case "7":
		since = time.Now().AddDate(0, 0, -7)
	case "14":
		since = time.Now().AddDate(0, 0, -14)
	case "30":
		since = time.Now().AddDate(0, 0, -30)
	default:
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "Unknown download option."))
		return
	}

	intakes, err := b.store.GetIntakesSince(since)
	if err != nil {
		log.Printf("Error getting intakes: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving intake data."))
		return
	}

	if len(intakes) == 0 {
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "No medication records found for the selected period."))
		return
	}

	csvData, err := b.generateCSV(intakes)
	if err != nil {
		log.Printf("Error generating CSV: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error generating CSV file."))
		return
	}

	// Update last download timestamp
	if err := b.store.UpdateLastDownload(time.Now()); err != nil {
		log.Printf("Error updating last download: %v", err)
	}

	// Remove buttons
	edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	b.api.Send(edit)

	// Send CSV as document
	doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
		Name:  "medication_export.csv",
		Bytes: csvData,
	})
	doc.Caption = fmt.Sprintf("Here is your medication export (%d records)", len(intakes))
	b.api.Send(doc)
}

func (b *Bot) generateCSV(intakes []store.IntakeWithMedication) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	// Write header
	if err := writer.Write([]string{"date time", "medicine name", "dosage"}); err != nil {
		return nil, err
	}

	// Write data rows
	for _, intake := range intakes {
		// Use actual intake timestamp when available, otherwise fall back to scheduled time
		dateTime := intake.ScheduledAt.Format("2006-01-02 15:04")
		if intake.TakenAt != nil {
			dateTime = intake.TakenAt.Format("2006-01-02 15:04")
		}
		row := []string{dateTime, intake.MedicationName, intake.MedicationDosage}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}
