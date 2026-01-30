package bot

import (
	"fmt"
	"log"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// handleStartNextCommand manually starts the next scheduled workout
func (b *Bot) handleStartNextCommand(msgConfig *tgbotapi.MessageConfig) {
	// Get today's sessions
	today := time.Now()
	todayStart := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())

	// Get all active groups
	groups, err := b.store.ListWorkoutGroups(b.allowedUserID, true)
	if err != nil {
		log.Printf("Error listing workout groups: %v", err)
		msgConfig.Text = "❌ Error retrieving workout groups."
		return
	}

	if len(groups) == 0 {
		msgConfig.Text = "No active workout groups found. Use the web app to create workouts first."
		return
	}

	// Find sessions for today
	var pendingSessions []struct {
		SessionID   int64
		GroupName   string
		VariantName string
		Time        string
	}

	for _, group := range groups {
		session, err := b.store.GetSessionByGroupAndDate(group.ID, todayStart)
		if err != nil {
			continue
		}

		if session != nil && (session.Status == "pending" || session.Status == "notified") {
			// Get variant name
			variant, err := b.store.GetWorkoutVariant(session.VariantID)
			if err != nil || variant == nil {
				continue
			}

			pendingSessions = append(pendingSessions, struct {
				SessionID   int64
				GroupName   string
				VariantName string
				Time        string
			}{
				SessionID:   session.ID,
				GroupName:   group.Name,
				VariantName: variant.Name,
				Time:        session.ScheduledTime,
			})
		}
	}

	if len(pendingSessions) == 0 {
		msgConfig.Text = "✅ No pending workouts for today!\nAll scheduled workouts are complete or skipped."
		return
	}

	// Build message with inline buttons for each session
	var sb strings.Builder
	sb.WriteString("**Select workout to start:**\n\n")

	var rows [][]tgbotapi.InlineKeyboardButton
	for i, s := range pendingSessions {
		sb.WriteString(fmt.Sprintf("%d. %s - %s (%s)\n", i+1, s.GroupName, s.VariantName, s.Time))

		callbackData := fmt.Sprintf("workout_start_%d", s.SessionID)
		btn := tgbotapi.NewInlineKeyboardButtonData(
			fmt.Sprintf("%d. %s - %s", i+1, s.GroupName, s.VariantName),
			callbackData,
		)
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
	msgConfig.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
}

// handleWorkoutStatusCommand shows today's workout status
func (b *Bot) handleWorkoutStatusCommand(msgConfig *tgbotapi.MessageConfig) {
	today := time.Now()
	todayStart := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())

	// Get all active groups
	groups, err := b.store.ListWorkoutGroups(b.allowedUserID, true)
	if err != nil {
		log.Printf("Error listing workout groups: %v", err)
		msgConfig.Text = "❌ Error retrieving workout status."
		return
	}

	if len(groups) == 0 {
		msgConfig.Text = "No active workout groups configured."
		return
	}

	var sb strings.Builder
	sb.WriteString("📊 **Today's Workout Status**\n")
	sb.WriteString(today.Format("Monday, January 2, 2006"))
	sb.WriteString("\n\n")

	totalCompleted := 0
	totalPending := 0
	totalSkipped := 0

	for _, group := range groups {
		session, err := b.store.GetSessionByGroupAndDate(group.ID, todayStart)
		if err != nil {
			continue
		}

		variant, _ := b.store.GetWorkoutVariant(session.VariantID)
		variantName := "Unknown"
		if variant != nil {
			variantName = variant.Name
		}

		if session != nil {
			statusEmoji := ""
			switch session.Status {
			case "completed":
				statusEmoji = "✅"
				totalCompleted++
			case "skipped":
				statusEmoji = "⏭"
				totalSkipped++
			case "in_progress":
				statusEmoji = "🏋️"
				totalPending++
			case "pending", "notified":
				statusEmoji = "⏰"
				totalPending++
			}

			sb.WriteString(fmt.Sprintf("%s **%s** - %s (%s)\n", statusEmoji, group.Name, variantName, session.ScheduledTime))

			// Show exercise completion if in progress or completed
			if session.Status == "in_progress" || session.Status == "completed" {
				logs, err := b.store.GetExerciseLogs(session.ID)
				if err == nil && len(logs) > 0 {
					exercises, _ := b.store.ListExercisesByVariant(session.VariantID)
					completedEx := 0
					for _, log := range logs {
						if log.Status == "completed" {
							completedEx++
						}
					}
					sb.WriteString(fmt.Sprintf("   Progress: %d/%d exercises\n", completedEx, len(exercises)))
				}
			}
		} else {
			// Not scheduled for today
			sb.WriteString(fmt.Sprintf("⚪ **%s** - Not scheduled\n", group.Name))
		}
	}

	sb.WriteString(fmt.Sprintf("\n**Summary:** %d completed, %d pending, %d skipped", totalCompleted, totalPending, totalSkipped))

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}

// handleWorkoutHistoryCommand shows recent workout history
func (b *Bot) handleWorkoutHistoryCommand(msgConfig *tgbotapi.MessageConfig) {
	sessions, err := b.store.GetWorkoutHistory(b.allowedUserID, 10)
	if err != nil {
		log.Printf("Error getting workout history: %v", err)
		msgConfig.Text = "❌ Error retrieving workout history."
		return
	}

	if len(sessions) == 0 {
		msgConfig.Text = "📈 **Workout History**\n\nNo workout sessions found yet."
		return
	}

	var sb strings.Builder
	sb.WriteString("📈 **Workout History** (last 10)\n\n")

	for _, session := range sessions {
		// Get group and variant names
		group, _ := b.store.GetWorkoutGroup(session.GroupID)
		variant, _ := b.store.GetWorkoutVariant(session.VariantID)

		groupName := "Unknown"
		variantName := "Unknown"
		if group != nil {
			groupName = group.Name
		}
		if variant != nil {
			variantName = variant.Name
		}

		statusEmoji := ""
		switch session.Status {
		case "completed":
			statusEmoji = "✅"
		case "skipped":
			statusEmoji = "⏭"
		case "in_progress":
			statusEmoji = "🏋️"
		default:
			statusEmoji = "⏰"
		}

		dateStr := session.ScheduledDate.Format("02.01")

		sb.WriteString(fmt.Sprintf("%s %s — %s - %s", statusEmoji, dateStr, groupName, variantName))

		// Add exercise completion info if available
		if session.Status == "completed" {
			logs, err := b.store.GetExerciseLogs(session.ID)
			if err == nil {
				completedCount := 0
				for _, log := range logs {
					if log.Status == "completed" {
						completedCount++
					}
				}
				sb.WriteString(fmt.Sprintf(" (%d ex.)", completedCount))
			}
		}

		sb.WriteString("\n")
	}

	// Calculate streak
	streak := 0
	for _, session := range sessions {
		if session.Status == "completed" {
			streak++
		} else if session.Status == "skipped" || session.Status == "pending" {
			break
		}
	}

	if streak > 0 {
		sb.WriteString(fmt.Sprintf("\n🔥 **Current streak:** %d workout%s", streak, map[bool]string{true: "s", false: ""}[streak != 1]))
	}

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}
