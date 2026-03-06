package bot

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

type Bot struct {
	api           *tgbotapi.BotAPI
	meds          MedicationStore
	medSvc        domain.MedicationService
	bp            BloodPressureStore
	weight        WeightStore
	reminderSvc   domain.ReminderService
	workouts      WorkoutStore
	workoutSvc    workoutsvc.WorkoutService
	exerciseSvc   domain.ExerciseService
	food          FoodStore
	imports       ImportStore
	allowedUserID int64
	appDomain     string
}

type featureFlags struct {
	Medication bool
	BP         bool
	Weight     bool
	Workout    bool
	Food       bool
}

func New(token string, allowedUserID int64, s *store.Store) (*Bot, error) {
	api, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		return nil, err
	}

	// Use local Bot API server if endpoint is configured
	if apiEndpoint := os.Getenv("TELEGRAM_API_ENDPOINT"); apiEndpoint != "" {
		log.Printf("Using custom Telegram API endpoint: %s", apiEndpoint)
		api.SetAPIEndpoint(apiEndpoint)
	}

	appDomain := os.Getenv("APP_DOMAIN")
	if appDomain == "" {
		appDomain = os.Getenv("DOMAIN")
	}

	return &Bot{
		api:           api,
		meds:          s,
		medSvc:        domain.NewMedicationService(s),
		bp:            s,
		weight:        s,
		reminderSvc:   domain.NewReminderService(s),
		workouts:      s,
		workoutSvc:    workoutsvc.New(s),
		exerciseSvc:   domain.NewExerciseService(s),
		food:          s,
		imports:       s,
		allowedUserID: allowedUserID,
		appDomain:     appDomain,
	}, nil
}

// Username returns the bot's username from the Telegram API
func (b *Bot) Username() string {
	return b.api.Self.UserName
}

func (b *Bot) getFeatureFlags(ctx context.Context) featureFlags {
	flags := featureFlags{
		Medication: true,
		BP:         true,
		Weight:     true,
		Workout:    true,
		Food:       false,
	}

	if v, err := b.meds.GetMedicationEnabled(ctx); err == nil {
		flags.Medication = v
	}
	if v, err := b.bp.GetBloodPressureEnabled(ctx); err == nil {
		flags.BP = v
	}
	if v, err := b.weight.GetWeightEnabled(ctx); err == nil {
		flags.Weight = v
	}
	if v, err := b.workouts.GetWorkoutEnabled(ctx); err == nil {
		flags.Workout = v
	}
	if v, err := b.food.GetFoodIntakeEnabled(ctx); err == nil {
		flags.Food = v
	}

	return flags
}

func (b *Bot) buildHelpText(flags featureFlags) string {
	var sections []string
	sections = append(sections, "**Medication Tracker Bot** - configurable tracker for meds, blood pressure, weight, workouts, and food.")

	if flags.Medication {
		sections = append(sections, `**Medication Commands:**
/log - Manually log a dose for any medication
/next - Trigger notification for next scheduled medication (with cancel option)
/stock - View medication inventory status
/download - Export medication, blood pressure, and weight history to CSV`)
	}

	if flags.BP || flags.Weight {
		var block strings.Builder
		block.WriteString("**Blood Pressure & Weight:**\n")
		if flags.BP {
			block.WriteString("/bp <systolic> <diastolic> [pulse] - Log blood pressure reading\n")
			block.WriteString("  Example: /bp 130 80 72\n")
			block.WriteString("/bphistory - View recent blood pressure history (last 10 readings)\n")
			block.WriteString("/bpstats - View blood pressure statistics (30-day averages)\n")
			block.WriteString("/bpgoal <systolic> <diastolic> - Set blood pressure goal\n")
		}
		if flags.Weight {
			block.WriteString("/weight <kg> - Log weight in kilograms\n")
			block.WriteString("  Example: /weight 75.5\n")
			block.WriteString("/weighthistory - View recent weight history (last 10 entries)\n")
			block.WriteString("/goal <weight> <date> - Set weight goal\n")
			block.WriteString("  Example: /goal 110 2026-06-01\n")
		}
		sections = append(sections, strings.TrimSpace(block.String()))
	}

	if flags.Workout {
		sections = append(sections, `**Workout Commands:**
/workout - Start an ad-hoc (unscheduled) workout
/startnext - Manually start next scheduled workout
/workoutstatus - View today's workout status
/workouthistory - View recent workouts and your streak 🔥`)
	}

	if flags.Food {
		sections = append(sections, `**Food Command:**
/intake <carbs> <protein> <fat> <weight> [name] - Log food intake`)
	}

	sections = append(sections, `**How to use:**
1. Click the "Menu" button to open the App
2. Enable or disable sections in Settings
3. Use enabled commands from this help
4. Use /help anytime after changing settings`)

	return strings.Join(sections, "\n\n")
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
	// Check for document upload (sleep import)
	if msg.Document != nil {
		b.handleDocumentUpload(msg)
		return
	}

	if !msg.IsCommand() {
		return
	}

	msgConfig := tgbotapi.NewMessage(msg.Chat.ID, "")
	flags := b.getFeatureFlags(context.Background())
	switch msg.Command() {
	case "help":
		msgConfig.Text = b.buildHelpText(flags)
		msgConfig.ParseMode = "Markdown"
	case "log":
		if !flags.Medication {
			msgConfig.Text = "⚠️ Medication section is disabled in settings."
			break
		}
		// Fetch active medications
		meds, err := b.meds.ListMedications(false)
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
			text := "Take " + m.Name
			if m.Dosage != "" {
				text += " (" + m.Dosage + ")"
			}
			btn := tgbotapi.NewInlineKeyboardButtonData(text, callbackData)
			rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
		}

		msgConfig.Text = "Select medication to log:"
		msgConfig.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	case "download":
		if !flags.Medication {
			msgConfig.Text = "⚠️ Medication section is disabled in settings."
			break
		}
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
		if !flags.BP {
			msgConfig.Text = "⚠️ Blood Pressure section is disabled in settings."
			break
		}
		b.handleBPCommand(msg, &msgConfig)
	case "bphistory":
		if !flags.BP {
			msgConfig.Text = "⚠️ Blood Pressure section is disabled in settings."
			break
		}
		b.handleBPHistoryCommand(&msgConfig)
	case "bpstats":
		if !flags.BP {
			msgConfig.Text = "⚠️ Blood Pressure section is disabled in settings."
			break
		}
		b.handleBPStatsCommand(&msgConfig)
	case "weight":
		if !flags.Weight {
			msgConfig.Text = "⚠️ Weight section is disabled in settings."
			break
		}
		b.handleWeightCommand(msg, &msgConfig)
	case "weighthistory":
		if !flags.Weight {
			msgConfig.Text = "⚠️ Weight section is disabled in settings."
			break
		}
		b.handleWeightHistoryCommand(&msgConfig)
	case "goal":
		if !flags.Weight {
			msgConfig.Text = "⚠️ Weight section is disabled in settings."
			break
		}
		b.handleGoalCommand(msg, &msgConfig)
	case "bpgoal":
		if !flags.BP {
			msgConfig.Text = "⚠️ Blood Pressure section is disabled in settings."
			break
		}
		b.handleBPGoalCommand(msg, &msgConfig)
	case "stock":
		if !flags.Medication {
			msgConfig.Text = "⚠️ Medication section is disabled in settings."
			break
		}
		b.handleStockCommand(&msgConfig)
	case "workout":
		if !flags.Workout {
			msgConfig.Text = "⚠️ Workouts section is disabled in settings."
			break
		}
		b.handleAdHocWorkoutCommand(&msgConfig)
	case "startnext":
		if !flags.Workout {
			msgConfig.Text = "⚠️ Workouts section is disabled in settings."
			break
		}
		b.handleStartNextCommand(&msgConfig)
	case "workoutstatus":
		if !flags.Workout {
			msgConfig.Text = "⚠️ Workouts section is disabled in settings."
			break
		}
		b.handleWorkoutStatusCommand(&msgConfig)
	case "workouthistory":
		if !flags.Workout {
			msgConfig.Text = "⚠️ Workouts section is disabled in settings."
			break
		}
		b.handleWorkoutHistoryCommand(&msgConfig)
	case "next":
		if !flags.Medication {
			msgConfig.Text = "⚠️ Medication section is disabled in settings."
			break
		}
		b.handleNextIntakeCommand(&msgConfig)
	case "intake":
		if !flags.Food {
			msgConfig.Text = "⚠️ Food section is disabled in settings."
			break
		}
		b.handleIntakeCommand(msg, &msgConfig)
	default:
		msgConfig.Text = "Unknown command. Try /help."
	}

	if _, err := b.api.Send(msgConfig); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}
}

func (b *Bot) handleCallback(cb *tgbotapi.CallbackQuery) {
	callbackCfg := tgbotapi.NewCallback(cb.ID, "")
	if _, err := b.api.Request(callbackCfg); err != nil {
		log.Printf("[bot] request failed: %v", err)
	}

	data := cb.Data
	// data format: "confirm_intake:<intakeID>", "skip_intake:<intakeID>", "confirm:<medID>", "confirm_schedule:<unix>", or "log:<medID>"
	if strings.HasPrefix(data, "confirm_intake:") {
		intakeIDStr := strings.TrimPrefix(data, "confirm_intake:")
		intakeID, _ := strconv.ParseInt(intakeIDStr, 10, 64)
		if intakeID == 0 {
			return
		}

		reminders, isSupp, err := b.medSvc.ConfirmIntakeWithCleanup(context.Background(), intakeID, time.Now())
		if err != nil {
			if errors.Is(err, domain.ErrNotPending) {
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⚠️ No pending intake found (or already taken).")); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
				return
			}
			log.Printf("Error confirming intake %d: %v", intakeID, err)
			return
		}

		for _, msgID := range reminders {
			if msgID != cb.Message.MessageID {
				if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID)); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
			}
		}

		callbacksToRemove := []string{data}
		if isSupp {
			callbacksToRemove = append(callbacksToRemove, "skip_intake:"+strconv.FormatInt(intakeID, 10))
		}
		b.removeButtonsFromCallbackMessage(cb, callbacksToRemove...)

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "✅ Marked as taken.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	} else if strings.HasPrefix(data, "skip_intake:") {
		intakeIDStr := strings.TrimPrefix(data, "skip_intake:")
		intakeID, _ := strconv.ParseInt(intakeIDStr, 10, 64)
		if intakeID == 0 {
			return
		}

		reminders, err := b.medSvc.SkipSupplementIntake(context.Background(), intakeID)
		if err != nil {
			if errors.Is(err, domain.ErrNotPending) {
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⚠️ No pending intake found (or already processed).")); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
				return
			}
			if errors.Is(err, domain.ErrNotSupplement) {
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⚠️ Skip is available only for supplements.")); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
				return
			}
			log.Printf("Error skipping intake %d: %v", intakeID, err)
			return
		}

		for _, msgID := range reminders {
			if msgID != cb.Message.MessageID {
				if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID)); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
			}
		}

		b.removeButtonsFromCallbackMessage(cb,
			"confirm_intake:"+strconv.FormatInt(intakeID, 10),
			"skip_intake:"+strconv.FormatInt(intakeID, 10),
		)

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⏭ Marked as skipped.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	} else if len(data) > 8 && data[:8] == "confirm:" {
		medIDStr := data[8:]
		medID, _ := strconv.ParseInt(medIDStr, 10, 64)

		reminders, _, err := b.medSvc.ConfirmMedicationByMedID(context.Background(), medID, time.Now())
		if err != nil {
			if errors.Is(err, domain.ErrNotPending) {
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "⚠️ No pending intake found (or already taken).")); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
				return
			}
			log.Printf("Error confirming intake for med %d: %v", medID, err)
			return
		}

		for _, msgID := range reminders {
			if msgID != cb.Message.MessageID {
				if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID)); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
			}
		}

		// Legacy callback path: only remove the pressed button.
		b.removeButtonFromCallbackMessage(cb, data)

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "✅ Marked as taken.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	} else if len(data) > 4 && data[:4] == "log:" {
		medIDStr := data[4:]
		medID, _ := strconv.ParseInt(medIDStr, 10, 64)

		if err := b.medSvc.LogMedicationNow(context.Background(), b.allowedUserID, medID); err != nil {
			log.Printf("Error logging medication now: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging medication.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		// Remove only the pressed button.
		b.removeButtonFromCallbackMessage(cb, data)

		// Fetch med name for confirmation (display only).
		med, _ := b.meds.GetMedication(medID)
		medName := "Medication"
		if med != nil {
			medName = med.Name
		}

		now := time.Now()
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, fmt.Sprintf("✅ Logged %s at %s", medName, now.Format("15:04")))); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

	} else if len(data) > 17 && data[:17] == "confirm_schedule:" {
		tsStr := data[17:]
		ts, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			return
		}

		target := time.Unix(ts, 0)

		reminders, err := b.medSvc.ConfirmScheduleWithCleanup(context.Background(), b.allowedUserID, target)
		if err != nil {
			log.Printf("Error confirming batch schedule: %v", err)
			return
		}

		for _, msgID := range reminders {
			if msgID != cb.Message.MessageID {
				if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, msgID)); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
			}
		}

		// Update message to remove buttons.
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "✅ All medications for this time marked as taken.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	} else if strings.HasPrefix(data, "workout_start_") || strings.HasPrefix(data, "workout_snooze1") || strings.HasPrefix(data, "workout_snooze2") || strings.HasPrefix(data, "workout_skip_") || strings.HasPrefix(data, "workout_finish_") {
		// Workout callbacks
		b.handleWorkoutCallback(cb, data)
	} else if len(data) > 13 && (data[:14] == "exercise_done_" || data[:14] == "exercise_edit_" || data[:14] == "exercise_skip_") {
		// Exercise callbacks
		b.handleExerciseCallback(cb, data)
	} else if strings.HasPrefix(data, "add_exercise_") {
		// Add exercise callback
		sessionIDStr := data[13:]
		sessionID, _ := strconv.ParseInt(sessionIDStr, 10, 64)
		b.handleAddExerciseCallback(cb, sessionID)
	} else if strings.HasPrefix(data, "select_exercise_") {
		// Select exercise callback
		parts := strings.Split(data, "_")
		if len(parts) == 4 {
			sessionID, _ := strconv.ParseInt(parts[2], 10, 64)
			exerciseID, _ := strconv.ParseInt(parts[3], 10, 64)
			b.handleSelectExerciseCallback(cb, sessionID, exerciseID)
		}
	} else if strings.HasPrefix(data, "exercise_page_") {
		// Exercise pagination callback
		parts := strings.Split(data, "_")
		if len(parts) == 4 {
			sessionID, _ := strconv.ParseInt(parts[2], 10, 64)
			page, _ := strconv.ParseInt(parts[3], 10, 64)
			b.handleExercisePageCallback(cb, sessionID, int(page))
		}
	} else if strings.HasPrefix(data, "page_info_") {
		// Page info button - ignore (it's just a display, not actionable)
	} else if len(data) > 9 && data[:9] == "download:" {
		option := data[9:]
		b.handleDownloadCallback(cb, option)
	} else if len(data) > 3 && (data == "bp_confirm" || data == "bp_snooze" || data == "bp_dontbug") {
		// BP reminder callbacks
		b.handleBPReminderCallback(cb, data)
	} else if data == "weight_confirm" || data == "weight_snooze" || data == "weight_dontbug" {
		// Weight reminder callbacks
		b.handleWeightReminderCallback(cb, data)
	} else if data == "dismiss_notification" {
		// Just delete the message
		if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	}
}

func (b *Bot) SendNotification(text string, intakeID int64, medicationID int64) (int, error) {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)

	// Add Confirm Button for an exact intake.
	data := "confirm_intake:" + strconv.FormatInt(intakeID, 10)
	if intakeID == 0 {
		// Backward-compatible fallback for legacy callsites.
		data = "confirm:" + strconv.FormatInt(medicationID, 10)
	}
	btn := tgbotapi.NewInlineKeyboardButtonData("✅ Confirm Intake", data)
	row := tgbotapi.NewInlineKeyboardRow(btn)
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(row)

	sentMsg, err := b.api.Send(msg)
	return sentMsg.MessageID, err
}

// SendSimpleNotification sends a notification with custom buttons
func (b *Bot) SendSimpleNotification(text string, buttons []tgbotapi.InlineKeyboardButton) (int, error) {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)

	if len(buttons) > 0 {
		rows := make([][]tgbotapi.InlineKeyboardButton, 0)
		for _, btn := range buttons {
			rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
		}
		msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	}

	sentMsg, err := b.api.Send(msg)
	return sentMsg.MessageID, err
}

// SendWorkoutStaleNotification sends a notification for a stale workout with Finish and Dismiss buttons
func (b *Bot) SendWorkoutStaleNotification(text string, sessionID int64) (int, error) {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)

	// Create buttons
	finishBtn := tgbotapi.NewInlineKeyboardButtonData("Finish Workout", fmt.Sprintf("workout_finish_%d", sessionID))
	dismissBtn := tgbotapi.NewInlineKeyboardButtonData("Dismiss", "dismiss_notification")

	row := tgbotapi.NewInlineKeyboardRow(finishBtn, dismissBtn)
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(row)

	sentMsg, err := b.api.Send(msg)
	return sentMsg.MessageID, err
}

// SendMarkdownNotification sends a Markdown-formatted message with action buttons.
// Actions are rendered as inline keyboard buttons, one per row.
// Returns the Telegram message ID.
func (b *Bot) SendMarkdownNotification(text string, actions []struct{ ID, Label string }) (int, error) {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"

	if len(actions) > 0 {
		var rows [][]tgbotapi.InlineKeyboardButton
		for _, a := range actions {
			btn := tgbotapi.NewInlineKeyboardButtonData(a.Label, a.ID)
			rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
		}
		msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	}

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, err
	}
	return sentMsg.MessageID, nil
}

// DeleteMessage deletes a message from the conversation
func (b *Bot) DeleteMessage(messageID int) error {
	deleteMsg := tgbotapi.NewDeleteMessage(b.allowedUserID, messageID)
	_, err := b.api.Request(deleteMsg)
	return err
}

func (b *Bot) SendGroupNotification(meds []store.Medication, intakeByMedication map[int64]int64, target time.Time) (int, error) {
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
		if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
			data = "confirm_intake:" + strconv.FormatInt(intakeID, 10)
		}
		text := "Take " + m.Name
		if m.Dosage != "" {
			text += " (" + m.Dosage + ")"
		}
		btn := tgbotapi.NewInlineKeyboardButtonData(text, data) // Shorten text
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	// 2. Confirm All Button
	// Key: "confirm_schedule:<unix_timestamp>"
	data := "confirm_schedule:" + strconv.FormatInt(target.Unix(), 10)
	btn := tgbotapi.NewInlineKeyboardButtonData("✅✅ Confirm ALL", data)
	rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))

	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, err
	}
	return sentMsg.MessageID, nil
}

// SendLowStockWarning sends a low stock warning message to the user
func (b *Bot) SendLowStockWarning(text string) error {
	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"
	_, err := b.api.Send(msg)
	return err
}

func (b *Bot) handleDownloadCallback(cb *tgbotapi.CallbackQuery, option string) {
	var since time.Time
	switch option {
	case "since_last":
		lastDownload, err := b.meds.GetLastDownload()
		if err != nil {
			log.Printf("Error getting last download: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving last download date.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}
		if lastDownload.IsZero() {
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "No previous download found. Please choose a time period.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
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
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "Unknown download option.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Get medication intakes
	intakes, err := b.meds.GetIntakesSince(since)
	if err != nil {
		log.Printf("Error getting intakes: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving intake data.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Get blood pressure readings
	bpReadings, err := b.bp.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting BP readings: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error retrieving blood pressure data.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Get weight logs
	weightLogs, err := b.weight.GetWeightLogs(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting weight logs: %v", err)
	}

	if len(intakes) == 0 && len(bpReadings) == 0 && len(weightLogs) == 0 {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "No records found for the selected period.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Update last download timestamp
	if err := b.meds.UpdateLastDownload(time.Now()); err != nil {
		log.Printf("Error updating last download: %v", err)
	}

	// Remove buttons
	edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	if _, err := b.api.Send(edit); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}

	// Send medication CSV if available
	if len(intakes) > 0 {
		medExports := make([]domain.MedicationIntake, len(intakes))
		for i, intake := range intakes {
			medExports[i] = domain.MedicationIntake{
				ScheduledAt:      intake.ScheduledAt,
				TakenAt:          intake.TakenAt,
				MedicationName:   intake.MedicationName,
				MedicationDosage: intake.MedicationDosage,
			}
		}
		csvData, err := domain.GenerateMedicationCSV(medExports)
		if err != nil {
			log.Printf("Error generating medication CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "medication_export.csv",
				Bytes: csvData,
			})
			doc.Caption = fmt.Sprintf("Medication export (%d records)", len(intakes))
			if _, err := b.api.Send(doc); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
		}
	}

	// Send BP CSV if available
	if len(bpReadings) > 0 {
		bpExports := make([]domain.BPExportReading, len(bpReadings))
		for i, bp := range bpReadings {
			bpExports[i] = domain.BPExportReading{
				MeasuredAt: bp.MeasuredAt,
				Systolic:   bp.Systolic,
				Diastolic:  bp.Diastolic,
				Pulse:      bp.Pulse,
				Category:   bp.Category,
			}
		}
		bpCSV, err := domain.GenerateBPCSV(bpExports)
		if err != nil {
			log.Printf("Error generating BP CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "blood_pressure_export.csv",
				Bytes: bpCSV,
			})
			doc.Caption = fmt.Sprintf("Blood pressure export (%d records)", len(bpReadings))
			if _, err := b.api.Send(doc); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
		}
	}

	// Send weight CSV if available
	if len(weightLogs) > 0 {
		wExports := make([]domain.WeightExportLog, len(weightLogs))
		for i, w := range weightLogs {
			wExports[i] = domain.WeightExportLog{
				MeasuredAt:      w.MeasuredAt,
				Weight:          w.Weight,
				WeightTrend:     w.WeightTrend,
				BodyFat:         w.BodyFat,
				BodyFatTrend:    w.BodyFatTrend,
				MuscleMass:      w.MuscleMass,
				MuscleMassTrend: w.MuscleMassTrend,
				Notes:           w.Notes,
			}
		}
		weightCSV, err := domain.GenerateWeightCSV(wExports)
		if err != nil {
			log.Printf("Error generating weight CSV: %v", err)
		} else {
			doc := tgbotapi.NewDocument(cb.Message.Chat.ID, tgbotapi.FileBytes{
				Name:  "weight_export.csv",
				Bytes: weightCSV,
			})
			doc.Caption = fmt.Sprintf("Weight export (%d records)", len(weightLogs))
			if _, err := b.api.Send(doc); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
		}
	}
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

	parts := strings.Fields(args)
	if len(parts) < 2 {
		msgConfig.Text = "❌ Invalid format. Use: /bp <systolic> <diastolic> [pulse]"
		return
	}

	systolic, err := strconv.Atoi(parts[0])
	if err != nil {
		msgConfig.Text = "❌ Invalid systolic value (60-250)"
		return
	}

	diastolic, err := strconv.Atoi(parts[1])
	if err != nil {
		msgConfig.Text = "❌ Invalid diastolic value (40-150)"
		return
	}

	pulse := 0
	pulsePresent := false
	if len(parts) >= 3 {
		pulse, err = strconv.Atoi(parts[2])
		if err != nil {
			msgConfig.Text = "❌ Invalid pulse value (40-200)"
			return
		}
		pulsePresent = true
	}

	if err := domain.ValidateBP(systolic, diastolic, pulse, pulsePresent); err != nil {
		if errors.Is(err, domain.ErrInvalidSystolic) {
			msgConfig.Text = "❌ Invalid systolic value (60-250)"
		} else if errors.Is(err, domain.ErrInvalidDiastolic) {
			msgConfig.Text = "❌ Invalid diastolic value (40-150)"
		} else if errors.Is(err, domain.ErrInvalidPulse) {
			msgConfig.Text = "❌ Invalid pulse value (40-200)"
		} else {
			msgConfig.Text = "❌ " + err.Error()
		}
		return
	}

	category := domain.CalculateBPCategory(systolic, diastolic)

	bp := &store.BloodPressure{
		UserID:     b.allowedUserID,
		MeasuredAt: time.Unix(int64(msg.Date), 0),
		Systolic:   systolic,
		Diastolic:  diastolic,
		Category:   category,
	}
	if pulsePresent {
		bp.Pulse = &pulse
	}

	_, err = b.bp.CreateBloodPressureReading(context.Background(), bp)
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
	readings, err := b.bp.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
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
			category = domain.CalculateBPCategory(bp.Systolic, bp.Diastolic)
		}
		fmt.Fprintf(&sb, "%s — %d/%d%s 📊 %s\n", dateStr, bp.Systolic, bp.Diastolic, pulseStr, category)
	}

	msgConfig.Text = sb.String()
}

func (b *Bot) handleBPStatsCommand(msgConfig *tgbotapi.MessageConfig) {
	since := time.Now().AddDate(0, 0, -30)
	readings, err := b.bp.GetBloodPressureReadings(context.Background(), b.allowedUserID, since)
	if err != nil {
		log.Printf("Error getting BP readings: %v", err)
		msgConfig.Text = "❌ Error retrieving blood pressure statistics."
		return
	}

	if len(readings) == 0 {
		msgConfig.Text = "📊 Statistics (30 days):\n\nNo records for the last 30 days."
		return
	}

	bpReadings := make([]domain.BPReading, len(readings))
	for i, bp := range readings {
		bpReadings[i] = domain.BPReading{
			Systolic:  bp.Systolic,
			Diastolic: bp.Diastolic,
			Pulse:     bp.Pulse,
		}
	}
	stats := domain.CalculateBPStats(bpReadings)
	msgConfig.Text = fmt.Sprintf("📊 Statistics (30 days):\n\n%s", stats.FormatBPStats())
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
	if err != nil {
		msgConfig.Text = "❌ Invalid weight value (30-300 kg)"
		return
	}
	if err := domain.ValidateWeight(weight); err != nil {
		msgConfig.Text = "❌ Invalid weight value (30-300 kg)"
		return
	}

	// Get last weight log to calculate trend
	lastLog, err := b.weight.GetLastWeightLog(context.Background(), b.allowedUserID)
	if err != nil {
		log.Printf("Error getting last weight log: %v", err)
	}

	var previousTrend *float64
	if lastLog != nil && lastLog.WeightTrend != nil {
		previousTrend = lastLog.WeightTrend
	}

	weightTrend := domain.CalculateWeightTrend(weight, previousTrend)

	wLog := &store.WeightLog{
		UserID:      b.allowedUserID,
		MeasuredAt:  time.Unix(int64(msg.Date), 0),
		Weight:      weight,
		WeightTrend: &weightTrend,
	}

	_, err = b.weight.CreateWeightLog(context.Background(), wLog)
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
	logs, err := b.weight.GetWeightLogs(context.Background(), b.allowedUserID, since)
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
		fmt.Fprintf(&sb, "%s — %.1f kg%s\n", dateStr, w.Weight, trendStr)
	}

	msgConfig.Text = sb.String()
}

func (b *Bot) handleGoalCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := msg.CommandArguments()
	if args == "" {
		// Show current goal
		goal, err := b.weight.GetWeightGoal()
		if err != nil {
			log.Printf("Error getting weight goal: %v", err)
			msgConfig.Text = "❌ Error retrieving weight goal."
			return
		}

		if goal.Goal == nil {
			msgConfig.Text = `**Weight Goal**

No goal set. Use: /goal <weight> <date>

Example: /goal 110 2026-06-01`
			msgConfig.ParseMode = "Markdown"
			return
		}

		dateStr := "not set"
		if goal.GoalDate != nil {
			dateStr = goal.GoalDate.Format("02.01.2006")
		}
		msgConfig.Text = fmt.Sprintf("🎯 Weight Goal: %.1f kg by %s", *goal.Goal, dateStr)
		return
	}

	parts := strings.Fields(args)
	if len(parts) < 2 {
		msgConfig.Text = "❌ Invalid format. Use: /goal <weight> <date>\nExample: /goal 110 2026-06-01"
		return
	}

	weight, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || weight < 30 || weight > 300 {
		msgConfig.Text = "❌ Invalid weight value (30-300 kg)"
		return
	}

	targetDate, err := time.Parse("2006-01-02", parts[1])
	if err != nil {
		msgConfig.Text = "❌ Invalid date format. Use YYYY-MM-DD (e.g., 2026-06-01)"
		return
	}

	if targetDate.Before(time.Now()) {
		msgConfig.Text = "❌ Goal date must be in the future"
		return
	}

	err = b.weight.SetWeightGoal(weight, targetDate)
	if err != nil {
		log.Printf("Error setting weight goal: %v", err)
		msgConfig.Text = "❌ Error saving weight goal."
		return
	}

	msgConfig.Text = fmt.Sprintf("✅ Weight goal set: %.1f kg by %s", weight, targetDate.Format("02.01.2006"))
}

func (b *Bot) handleBPGoalCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	args := msg.CommandArguments()
	if args == "" {
		// Show current goal
		goal, err := b.bp.GetBPGoal()
		if err != nil {
			log.Printf("Error getting BP goal: %v", err)
			msgConfig.Text = "❌ Error retrieving BP goal."
			return
		}

		if goal.TargetSystolic == nil {
			msgConfig.Text = `**Blood Pressure Goal**

No goal set. Use: /bpgoal <systolic> <diastolic>

Example: /bpgoal 120 70`
			msgConfig.ParseMode = "Markdown"
			return
		}

		diastolicStr := "not set"
		if goal.TargetDiastolic != nil {
			diastolicStr = fmt.Sprintf("%d", *goal.TargetDiastolic)
		}
		msgConfig.Text = fmt.Sprintf("🎯 BP Goal: <%d/%s mmHg", *goal.TargetSystolic, diastolicStr)
		return
	}

	parts := strings.Fields(args)
	if len(parts) < 2 {
		msgConfig.Text = "❌ Invalid format. Use: /bpgoal <systolic> <diastolic>\nExample: /bpgoal 120 70"
		return
	}

	systolic, err := strconv.Atoi(parts[0])
	if err != nil || systolic < 80 || systolic > 200 {
		msgConfig.Text = "❌ Invalid systolic value (80-200)"
		return
	}

	diastolic, err := strconv.Atoi(parts[1])
	if err != nil || diastolic < 40 || diastolic > 120 {
		msgConfig.Text = "❌ Invalid diastolic value (40-120)"
		return
	}

	err = b.bp.SetBPGoal(systolic, diastolic)
	if err != nil {
		log.Printf("Error setting BP goal: %v", err)
		msgConfig.Text = "❌ Error saving BP goal."
		return
	}

	msgConfig.Text = fmt.Sprintf("✅ BP goal set: <%d/%d mmHg", systolic, diastolic)
}

// -- Inventory Command --

func (b *Bot) handleStockCommand(msgConfig *tgbotapi.MessageConfig) {
	meds, err := b.meds.ListMedications(false)
	if err != nil {
		log.Printf("Error getting medications: %v", err)
		msgConfig.Text = "❌ Error retrieving medications."
		return
	}

	// Filter to only medications with inventory tracking
	var trackedMeds []store.Medication
	for _, m := range meds {
		if m.InventoryCount != nil {
			trackedMeds = append(trackedMeds, m)
		}
	}

	if len(trackedMeds) == 0 {
		msgConfig.Text = "📦 **Medication Inventory**\n\nNo medications are being tracked for inventory.\n\nTo enable tracking, edit a medication in the web app and set the stock count."
		msgConfig.ParseMode = "Markdown"
		return
	}

	var sb strings.Builder
	sb.WriteString("📦 **Medication Inventory**\n\n")

	// Check for low stock (< 7 days)
	lowStockMeds, _ := b.meds.GetMedicationsLowOnStock(7)
	lowStockIDs := make(map[int64]bool)
	for _, m := range lowStockMeds {
		lowStockIDs[m.ID] = true
	}

	for _, m := range trackedMeds {
		daysRemaining := b.meds.GetDaysOfStockRemaining(&m)

		icon := "✅"
		if lowStockIDs[m.ID] {
			icon = "⚠️"
		}

		daysStr := ""
		if daysRemaining != nil {
			daysStr = fmt.Sprintf(" (~%.0f days)", *daysRemaining)
		}

		fmt.Fprintf(&sb, "%s **%s**: %d units%s\n", icon, m.Name, *m.InventoryCount, daysStr)
	}

	if len(lowStockMeds) > 0 {
		sb.WriteString("\n⚠️ = Low stock (won't last 7 days or until end date)")
	}

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}

// handleNextIntakeCommand sends a notification for the next scheduled medication with confirm/cancel buttons
func (b *Bot) handleNextIntakeCommand(msgConfig *tgbotapi.MessageConfig) {
	// Get all active medications
	meds, err := b.meds.ListMedications(false)
	if err != nil {
		msgConfig.Text = "❌ Error fetching medications."
		return
	}

	now := time.Now()
	var nextTime time.Time
	var nextMeds []store.Medication

	// Find the next scheduled intake (within 12 hours)
	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil || cfg.Type == "as_needed" {
			continue
		}

		// Check today and tomorrow
		for daysAhead := 0; daysAhead < 1; daysAhead++ {
			checkDay := now.AddDate(0, 0, daysAhead)

			// If "weekly", check day
			if cfg.Type == "weekly" {
				dayIdx := int(checkDay.Weekday())
				found := false
				for _, d := range cfg.Days {
					if d == dayIdx {
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}

			// Iterate over times
			for _, timeStr := range cfg.Times {
				if len(timeStr) != 5 {
					continue
				}
				var hour, minute int
				_, _ = fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())

				// Skip if in the past
				if target.Before(now) {
					continue
				}

				// Skip if more than 12 hours in the future
				if target.Sub(now) > 12*time.Hour {
					continue
				}

				// Check Start/End Dates
				if med.StartDate != nil && target.Before(*med.StartDate) {
					continue
				}
				if med.EndDate != nil && target.After(*med.EndDate) {
					continue
				}

				// Is this the earliest we've found?
				if nextTime.IsZero() || target.Before(nextTime) {
					nextTime = target
					nextMeds = []store.Medication{med}
				} else if target.Equal(nextTime) {
					nextMeds = append(nextMeds, med)
				}
			}
		}
	}

	if len(nextMeds) == 0 {
		msgConfig.Text = "No upcoming scheduled medications found (within next 12 hours)."
		return
	}

	// Create or find existing pending intakes for this schedule
	intakeByMedication := make(map[int64]int64, len(nextMeds))
	for _, med := range nextMeds {
		intake, _ := b.meds.GetIntakeBySchedule(med.ID, nextTime)
		if intake == nil {
			// Create pending intake
			id, err := b.meds.CreateIntake(med.ID, b.allowedUserID, nextTime)
			if err != nil {
				log.Printf("Error creating intake for /next command: %v", err)
				continue
			}
			intakeByMedication[med.ID] = id
		} else if intake.Status == "PENDING" {
			intakeByMedication[med.ID] = intake.ID
		}
	}

	if len(intakeByMedication) == 0 {
		msgConfig.Text = "⚠️ All upcoming medications already taken or no pending intakes found."
		return
	}

	// Send a group notification with confirm buttons
	var sb string
	sb = fmt.Sprintf("💊 Your next scheduled medications (%s):\n\n", nextTime.Format("15:04"))
	for _, m := range nextMeds {
		if m.Dosage != "" {
			sb += fmt.Sprintf("- %s (%s)\n", m.Name, m.Dosage)
		} else {
			sb += fmt.Sprintf("- %s\n", m.Name)
		}
	}

	msg := tgbotapi.NewMessage(b.allowedUserID, sb)

	var rows [][]tgbotapi.InlineKeyboardButton

	// Individual confirm buttons
	for _, m := range nextMeds {
		data := "confirm:" + strconv.FormatInt(m.ID, 10)
		if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
			data = "confirm_intake:" + strconv.FormatInt(intakeID, 10)
		}
		text := "Take " + m.Name
		if m.Dosage != "" {
			text += " (" + m.Dosage + ")"
		}
		btn := tgbotapi.NewInlineKeyboardButtonData(text, data)
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	// Confirm All Button
	data := "confirm_schedule:" + strconv.FormatInt(nextTime.Unix(), 10)
	btn := tgbotapi.NewInlineKeyboardButtonData("✅✅ Confirm ALL", data)
	rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))

	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)

	if _, err := b.api.Send(msg); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}
	msgConfig.Text = "" // Don't send the original message config
}

func (b *Bot) removeButtonFromCallbackMessage(cb *tgbotapi.CallbackQuery, callbackData string) {
	b.removeButtonsFromCallbackMessage(cb, callbackData)
}

func (b *Bot) removeButtonsFromCallbackMessage(cb *tgbotapi.CallbackQuery, callbackData ...string) {
	if cb == nil || cb.Message == nil || cb.Message.Chat == nil {
		return
	}

	toRemove := make(map[string]struct{}, len(callbackData))
	for _, cbData := range callbackData {
		if cbData == "" {
			continue
		}
		toRemove[cbData] = struct{}{}
	}
	if len(toRemove) == 0 {
		return
	}

	current := cb.Message.ReplyMarkup.InlineKeyboard
	if len(current) == 0 {
		// Safe fallback when Telegram callback payload doesn't include current markup.
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	rows := make([][]tgbotapi.InlineKeyboardButton, 0, len(current))
	for _, row := range current {
		filtered := make([]tgbotapi.InlineKeyboardButton, 0, len(row))
		for _, btn := range row {
			if btn.CallbackData != nil {
				if _, shouldRemove := toRemove[*btn.CallbackData]; shouldRemove {
					continue
				}
			}
			filtered = append(filtered, btn)
		}
		if len(filtered) > 0 {
			rows = append(rows, filtered)
		}
	}

	edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: rows,
	})
	if _, err := b.api.Send(edit); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}
}

// UpdateWorkoutMessage updates a workout notification message
func (b *Bot) UpdateWorkoutMessage(msgID int, text string) error {
	// 1. Edit Text
	edit := tgbotapi.NewEditMessageText(b.allowedUserID, msgID, text)
	edit.ParseMode = "Markdown"
	if _, err := b.api.Send(edit); err != nil {
		return err
	}

	// 2. Remove Buttons (EditReplyMarkup with empty markup)
	editMarkup := tgbotapi.NewEditMessageReplyMarkup(b.allowedUserID, msgID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	if _, err := b.api.Send(editMarkup); err != nil {
		return err
	}

	return nil
}
