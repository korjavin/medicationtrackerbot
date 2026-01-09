package bot

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"log"
	"strconv"
	"strings"
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
		msgConfig.Text = `**Medication Tracker Bot** - Track medications, blood pressure, and weight.

**Commands:**
/start - Start the bot and open the Mini App
/log - Manually log a dose for any medication (useful for "As Needed" meds)
/download - Export medication, blood pressure, and weight history to CSV
/bp <systolic> <diastolic> [pulse] - Log blood pressure reading
  Example: /bp 130 80 72
/bphistory - View recent blood pressure history (last 10 readings)
/bpstats - View blood pressure statistics (30-day averages)
/weight <kg> - Log weight in kilograms
  Example: /weight 75.5
/weighthistory - View recent weight history (last 10 entries)

**How to use:**
1. Click the "Menu" button to open the App
2. Add your medications and set schedules
3. The bot will notify you when it's time to take them
4. Click "Confirm" on the notification to log usage
5. Use the tabs to track your BP readings and weight
6. Use /download to export all data for any time period`
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
	case "bp":
		b.handleBPCommand(msg, &msgConfig)
	case "bphistory":
		b.handleBPHistoryCommand(&msgConfig)
	case "bpstats":
		b.handleBPStatsCommand(&msgConfig)
	case "weight":
		b.handleWeightCommand(msg, &msgConfig)
	case "weighthistory":
		b.handleWeightHistoryCommand(&msgConfig)
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

	// Get medication intakes
	intakes, err := b.store.GetIntakesSince(since)
	if err != nil {
		log.Printf("Error getting intakes: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving intake data."))
		return
	}

	// Get blood pressure readings
	bpReadings, err := b.store.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting BP readings: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving blood pressure data."))
		return
	}

	// Get weight logs
	weightLogs, err := b.store.GetWeightLogs(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting weight logs: %v", err)
	}

	if len(intakes) == 0 && len(bpReadings) == 0 && len(weightLogs) == 0 {
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "No records found for the selected period."))
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

	// Send medication CSV if available
	if len(intakes) > 0 {
		csvData, err := b.generateCSV(intakes)
		if err != nil {
			log.Printf("Error generating medication CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "medication_export.csv",
				Bytes: csvData,
			})
			doc.Caption = fmt.Sprintf("Medication export (%d records)", len(intakes))
			b.api.Send(doc)
		}
	}

	// Send BP CSV if available
	if len(bpReadings) > 0 {
		bpCSV, err := b.generateBPCSV(bpReadings)
		if err != nil {
			log.Printf("Error generating BP CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "blood_pressure_export.csv",
				Bytes: bpCSV,
			})
			doc.Caption = fmt.Sprintf("Blood pressure export (%d records)", len(bpReadings))
			b.api.Send(doc)
		}
	}

	// Send weight CSV if available
	if len(weightLogs) > 0 {
		weightCSV, err := b.generateWeightCSV(weightLogs)
		if err != nil {
			log.Printf("Error generating weight CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "weight_export.csv",
				Bytes: weightCSV,
			})
			doc.Caption = fmt.Sprintf("Weight export (%d records)", len(weightLogs))
			b.api.Send(doc)
		}
	}
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

// -- Blood Pressure Commands --

func (b *Bot) handleBPCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := msg.CommandArguments()
	if args == "" {
		msgConfig.Text = `**Blood Pressure Logging**

Usage: /bp <systolic> <diastolic> [pulse]

Examples:
  /bp 130 80 - Log BP 130/80 without pulse
  /bp 130 80 72 - Log BP 130/80 with pulse 72

Systolic: upper number (max pressure)
Diastolic: lower number (min pressure)
Pulse: heart rate (optional)`
		msgConfig.ParseMode = "Markdown"
		return
	}

	parts := parseBPArgs(args)
	if len(parts) < 2 {
		msgConfig.Text = "❌ Invalid format. Use: /bp <systolic> <diastolic> [pulse]"
		return
	}

	systolic, err := strconv.Atoi(parts[0])
	if err != nil || systolic < 60 || systolic > 250 {
		msgConfig.Text = "❌ Invalid systolic value (60-250)"
		return
	}

	diastolic, err := strconv.Atoi(parts[1])
	if err != nil || diastolic < 40 || diastolic > 150 {
		msgConfig.Text = "❌ Invalid diastolic value (40-150)"
		return
	}

	pulse := 0
	pulsePresent := false
	if len(parts) >= 3 {
		pulse, err = strconv.Atoi(parts[2])
		if err != nil || pulse < 40 || pulse > 200 {
			msgConfig.Text = "❌ Invalid pulse value (40-200)"
			return
		}
		pulsePresent = true
	}

	category := store.CalculateBPCategory(systolic, diastolic)

	bp := &store.BloodPressure{
		UserID:     b.allowedUserID,
		MeasuredAt: time.Now(),
		Systolic:   systolic,
		Diastolic:  diastolic,
		Category:   category,
	}
	if pulsePresent {
		bp.Pulse = &pulse
	}

	_, err = b.store.CreateBloodPressureReading(context.Background(), bp)
	if err != nil {
		log.Printf("Error creating BP reading: %v", err)
		msgConfig.Text = "❌ Error saving blood pressure reading."
		return
	}

	pulseStr := ""
	if pulsePresent {
		pulseStr = fmt.Sprintf(", pulse %d", pulse)
	}
	msgConfig.Text = fmt.Sprintf("✅ Blood pressure recorded: %d/%d%s\n📊 Category: %s", systolic, diastolic, pulseStr, category)
}

func (b *Bot) handleBPHistoryCommand(msgConfig *tgbotapi.MessageConfig) {
	since := time.Now().AddDate(0, 0, -30)
	readings, err := b.store.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting BP readings: %v", err)
		msgConfig.Text = "❌ Error retrieving blood pressure history."
		return
	}

	if len(readings) == 0 {
		msgConfig.Text = "📈 Blood Pressure History (last 10):\n\nNo records for the last 30 days."
		return
	}

	// Limit to 10
	if len(readings) > 10 {
		readings = readings[:10]
	}

	var sb strings.Builder
	sb.WriteString("📈 Blood Pressure History (last 10):\n\n")

	for _, bp := range readings {
		dateStr := bp.MeasuredAt.Format("02.01.2006 15:04")
		pulseStr := ""
		if bp.Pulse != nil {
			pulseStr = fmt.Sprintf(", pulse %d", *bp.Pulse)
		}
		category := bp.Category
		if category == "" {
			category = store.CalculateBPCategory(bp.Systolic, bp.Diastolic)
		}
		sb.WriteString(fmt.Sprintf("%s — %d/%d%s 📊 %s\n", dateStr, bp.Systolic, bp.Diastolic, pulseStr, category))
	}

	msgConfig.Text = sb.String()
}

func (b *Bot) handleBPStatsCommand(msgConfig *tgbotapi.MessageConfig) {
	since := time.Now().AddDate(0, 0, -30)
	readings, err := b.store.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting BP readings: %v", err)
		msgConfig.Text = "❌ Error retrieving blood pressure statistics."
		return
	}

	if len(readings) == 0 {
		msgConfig.Text = "📊 Statistics (30 days):\n\nNo records for the last 30 days."
		return
	}

	var sumSys, sumDia, sumPulse int
	var countPulse int
	minSys, maxSys := readings[0].Systolic, readings[0].Systolic
	minDia, maxDia := readings[0].Diastolic, readings[0].Diastolic
	minPulse, maxPulse := 999, -999

	for _, bp := range readings {
		sumSys += bp.Systolic
		sumDia += bp.Diastolic

		if bp.Systolic < minSys {
			minSys = bp.Systolic
		}
		if bp.Systolic > maxSys {
			maxSys = bp.Systolic
		}
		if bp.Diastolic < minDia {
			minDia = bp.Diastolic
		}
		if bp.Diastolic > maxDia {
			maxDia = bp.Diastolic
		}

		if bp.Pulse != nil {
			sumPulse += *bp.Pulse
			countPulse++
			if *bp.Pulse < minPulse {
				minPulse = *bp.Pulse
			}
			if *bp.Pulse > maxPulse {
				maxPulse = *bp.Pulse
			}
		}
	}

	avgSys := sumSys / len(readings)
	avgDia := sumDia / len(readings)
	avgPulse := 0
	if countPulse > 0 {
		avgPulse = sumPulse / countPulse
	}

	pulsePart := ""
	if countPulse > 0 {
		pulsePart = fmt.Sprintf(", pulse %d", avgPulse)
	}
	msgConfig.Text = fmt.Sprintf("📊 Statistics (30 days):\n\nAverage: %d/%d%s", avgSys, avgDia, pulsePart)
	if countPulse > 0 {
		msgConfig.Text += fmt.Sprintf("\nMax: %d/%d, pulse %d", maxSys, maxDia, maxPulse)
		msgConfig.Text += fmt.Sprintf("\nMin: %d/%d, pulse %d", minSys, minDia, minPulse)
	} else {
		msgConfig.Text += fmt.Sprintf("\nMax: %d/%d, pulse —", maxSys, maxDia)
		msgConfig.Text += fmt.Sprintf("\nMin: %d/%d, pulse —", minSys, minDia)
	}
}

func (b *Bot) generateBPCSV(readings []store.BloodPressure) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	// Write header
	if err := writer.Write([]string{"date time", "systolic", "diastolic", "pulse", "category"}); err != nil {
		return nil, err
	}

	// Write data rows
	for _, bp := range readings {
		dateTime := bp.MeasuredAt.Format("2006-01-02 15:04")
		pulse := ""
		if bp.Pulse != nil {
			pulse = strconv.Itoa(*bp.Pulse)
		}
		category := bp.Category
		if category == "" {
			category = store.CalculateBPCategory(bp.Systolic, bp.Diastolic)
		}
		row := []string{dateTime, strconv.Itoa(bp.Systolic), strconv.Itoa(bp.Diastolic), pulse, category}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}

func (b *Bot) generateWeightCSV(logs []store.WeightLog) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	// Write header in Libra format
	writer.Write([]string{"#Version: 6"})
	writer.Write([]string{"#Units: kg"})
	writer.Write([]string{""})
	writer.Write([]string{"#date;weight;weight trend;body fat;body fat trend;muscle mass;muscle mass trend;log"})

	// Write data rows
	for _, w := range logs {
		dateTime := w.MeasuredAt.Format("2006-01-02T15:04:05.000Z")

		weight := fmt.Sprintf("%.1f", w.Weight)
		weightTrend := ""
		if w.WeightTrend != nil {
			weightTrend = fmt.Sprintf("%.1f", *w.WeightTrend)
		}

		bodyFat := ""
		if w.BodyFat != nil {
			bodyFat = fmt.Sprintf("%.1f", *w.BodyFat)
		}

		bodyFatTrend := ""
		if w.BodyFatTrend != nil {
			bodyFatTrend = fmt.Sprintf("%.1f", *w.BodyFatTrend)
		}

		muscleMass := ""
		if w.MuscleMass != nil {
			muscleMass = fmt.Sprintf("%.1f", *w.MuscleMass)
		}

		muscleMassTrend := ""
		if w.MuscleMassTrend != nil {
			muscleMassTrend = fmt.Sprintf("%.1f", *w.MuscleMassTrend)
		}

		row := []string{
			dateTime + ";" + weight + ";" + weightTrend + ";" + bodyFat + ";" + bodyFatTrend + ";" + muscleMass + ";" + muscleMassTrend + ";" + w.Notes,
		}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}

func parseBPArgs(args string) []string {
	var parts []string
	var current []byte
	for _, c := range args {
		if c == ' ' || c == '\t' {
			if len(current) > 0 {
				parts = append(parts, string(current))
				current = nil
			}
		} else {
			current = append(current, byte(c))
		}
	}
	if len(current) > 0 {
		parts = append(parts, string(current))
	}
	return parts
}

// -- Weight Tracking Commands --

func (b *Bot) handleWeightCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := msg.CommandArguments()
	if args == "" {
		msgConfig.Text = `**Weight Logging**

Usage: /weight <weight_in_kg>

Examples:
  /weight 75.5 - Log weight 75.5 kg
  /weight 80.2 - Log weight 80.2 kg

The system will automatically calculate your weight trend over time.`
		msgConfig.ParseMode = "Markdown"
		return
	}

	parts := strings.Fields(args)
	if len(parts) < 1 {
		msgConfig.Text = "❌ Invalid format. Use: /weight <weight_in_kg>"
		return
	}

	weight, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || weight < 30 || weight > 300 {
		msgConfig.Text = "❌ Invalid weight value (30-300 kg)"
		return
	}

	// Get last weight log to calculate trend
	lastLog, err := b.store.GetLastWeightLog(context.Background(), b.allowedUserID)
	if err != nil {
		log.Printf("Error getting last weight log: %v", err)
	}

	var previousTrend *float64
	if lastLog != nil && lastLog.WeightTrend != nil {
		previousTrend = lastLog.WeightTrend
	}

	weightTrend := store.CalculateWeightTrend(weight, previousTrend)

	wLog := &store.WeightLog{
		UserID:      b.allowedUserID,
		MeasuredAt:  time.Now(),
		Weight:      weight,
		WeightTrend: &weightTrend,
	}

	_, err = b.store.CreateWeightLog(context.Background(), wLog)
	if err != nil {
		log.Printf("Error creating weight log: %v", err)
		msgConfig.Text = "❌ Error saving weight log."
		return
	}

	trendInfo := ""
	if lastLog != nil {
		diff := weight - lastLog.Weight
		trendDiff := weightTrend - *lastLog.WeightTrend
		if diff > 0 {
			trendInfo = fmt.Sprintf("\n📈 Change: +%.1f kg (trend: %+.1f kg)", diff, trendDiff)
		} else if diff < 0 {
			trendInfo = fmt.Sprintf("\n📉 Change: %.1f kg (trend: %.1f kg)", diff, trendDiff)
		}
	}

	msgConfig.Text = fmt.Sprintf("✅ Weight recorded: %.1f kg\n📊 Trend: %.1f kg%s", weight, weightTrend, trendInfo)
}

func (b *Bot) handleWeightHistoryCommand(msgConfig *tgbotapi.MessageConfig) {
	since := time.Now().AddDate(0, 0, -30)
	logs, err := b.store.GetWeightLogs(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting weight logs: %v", err)
		msgConfig.Text = "❌ Error retrieving weight history."
		return
	}

	if len(logs) == 0 {
		msgConfig.Text = "📊 Weight History (last 10):\n\nNo records for the last 30 days."
		return
	}

	// Limit to 10
	if len(logs) > 10 {
		logs = logs[:10]
	}

	var sb strings.Builder
	sb.WriteString("📊 Weight History (last 10):\n\n")

	for _, w := range logs {
		dateStr := w.MeasuredAt.Format("02.01.2006 15:04")
		trendStr := ""
		if w.WeightTrend != nil {
			trendStr = fmt.Sprintf(" (trend: %.1f kg)", *w.WeightTrend)
		}
		sb.WriteString(fmt.Sprintf("%s — %.1f kg%s\n", dateStr, w.Weight, trendStr))
	}

	msgConfig.Text = sb.String()
}
