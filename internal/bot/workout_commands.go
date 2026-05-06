package bot

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// userLocation returns the time.Location for the stored user timezone,
// falling back to the system timezone when unavailable or invalid. The nil
// guard on b.timezone matters for unit tests that build a partial Bot
// fixture without wiring the timezone store.
func (b *Bot) userLocation() *time.Location {
	if b.timezone == nil {
		return time.Local
	}
	tz, err := b.timezone.GetCurrentTimezone()
	if err != nil || tz == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		slog.Warn("Invalid stored timezone, falling back to system TZ", "tz", tz, "error", err)
		return time.Local
	}
	return loc
}

// handleStartNextCommand manually starts the next scheduled workout
func (b *Bot) handleStartNextCommand(msgConfig *tgbotapi.MessageConfig) {
	// Get today's sessions in the user's timezone
	today := time.Now().In(b.userLocation())
	todayStart := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())

	// Get all active groups
	groups, err := b.workouts.ListWorkoutGroups(b.allowedUserID, true)
	if err != nil {
		slog.Error("Error listing workout groups", "error", err)
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
		session, err := b.workouts.GetSessionByGroupAndDate(group.ID, todayStart)
		if err != nil {
			continue
		}

		if session != nil && (session.Status == "pending" || session.Status == "notified") {
			// Get variant name
			variant, err := b.workouts.GetWorkoutVariant(session.VariantID)
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
		fmt.Fprintf(&sb,
			"%d. %s - %s (%s)\n", i+1, s.GroupName, s.VariantName, s.Time)

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
	today := time.Now().In(b.userLocation())
	todayStart := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, today.Location())

	// Get all active groups
	groups, err := b.workouts.ListWorkoutGroups(b.allowedUserID, true)
	if err != nil {
		slog.Error("Error listing workout groups", "error", err)
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
		session, err := b.workouts.GetSessionByGroupAndDate(group.ID, todayStart)
		if err != nil {
			continue
		}

		if session != nil {
			variant, _ := b.workouts.GetWorkoutVariant(session.VariantID)
			variantName := "Unknown"
			if variant != nil {
				variantName = variant.Name
			}

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

			fmt.Fprintf(&sb,
				"%s **%s** - %s (%s)\n", statusEmoji, group.Name, variantName, session.ScheduledTime)

			// Show exercise completion if in progress or completed
			if session.Status == "in_progress" || session.Status == "completed" {
				logs, err := b.workouts.GetExerciseLogs(session.ID)
				if err == nil && len(logs) > 0 {
					exercises, _ := b.workouts.ListExercisesByVariant(session.VariantID)
					completedEx := 0
					for _, log := range logs {
						if log.Status == "completed" {
							completedEx++
						}
					}
					fmt.Fprintf(&sb,
						"   Progress: %d/%d exercises\n", completedEx, len(exercises))
				}
			}
		} else {
			// Not scheduled for today
			fmt.Fprintf(&sb,
				"⚪ **%s** - Not scheduled\n", group.Name)
		}
	}

	fmt.Fprintf(&sb,
		"\n**Summary:** %d completed, %d pending, %d skipped", totalCompleted, totalPending, totalSkipped)

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}

type historyItem struct {
	ts      time.Time
	session *store.WorkoutSession
	manual  *store.MiBandWorkout
}

// handleWorkoutHistoryCommand shows recent workout history
func (b *Bot) handleWorkoutHistoryCommand(msgConfig *tgbotapi.MessageConfig) {
	// Fetch more than needed from each source so the merged+truncated list is correct.
	const limit = 10
	sessions, err := b.workouts.GetWorkoutHistory(b.allowedUserID, limit*2)
	if err != nil {
		slog.Error("Error getting workout history", "error", err)
		msgConfig.Text = "❌ Error retrieving workout history."
		return
	}

	miband, err := b.imports.ListMiBandWorkouts(context.Background(), b.allowedUserID, limit*2)
	if err != nil {
		slog.Warn("handleWorkoutHistory: failed to fetch manual activities", "error", err)
	}

	// Build unified list
	var items []historyItem
	for i := range sessions {
		s := &sessions[i]
		var ts time.Time
		if s.StartedAt != nil {
			ts = *s.StartedAt
		} else {
			ts = s.ScheduledDate
		}
		items = append(items, historyItem{ts: ts, session: s})
	}
	for i := range miband {
		w := &miband[i]
		if w.Source != "manual" {
			continue
		}
		items = append(items, historyItem{ts: time.UnixMilli(w.SourceStartMs), manual: w})
	}

	// Sort newest first, then truncate to limit
	sort.Slice(items, func(i, j int) bool { return items[i].ts.After(items[j].ts) })
	if len(items) > limit {
		items = items[:limit]
	}

	if len(items) == 0 {
		msgConfig.Text = "📈 **Workout History**\n\nNo workout sessions found yet."
		return
	}

	var sb strings.Builder
	sb.WriteString("📈 **Workout History** (last 10)\n\n")

	var sessionStatuses []domain.SessionStatus
	for _, item := range items {
		if item.session != nil {
			session := item.session
			// Get group and variant names
			group, _ := b.workouts.GetWorkoutGroup(session.GroupID)
			variant, _ := b.workouts.GetWorkoutVariant(session.VariantID)

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
			fmt.Fprintf(&sb, "%s %s — %s - %s", statusEmoji, dateStr, groupName, variantName)

			if session.Status == "completed" {
				logs, err := b.workouts.GetExerciseLogs(session.ID)
				if err == nil {
					completedCount := 0
					for _, log := range logs {
						if log.Status == "completed" {
							completedCount++
						}
					}
					fmt.Fprintf(&sb, " (%d ex.)", completedCount)
				}
			}

			sb.WriteString("\n")
			sessionStatuses = append(sessionStatuses, domain.SessionStatus{Status: session.Status})
		} else {
			w := item.manual
			line := fmt.Sprintf("✍️ %s — %s", item.ts.Format("02.01"), w.ActivityName)
			if w.DurationSec > 0 {
				line += fmt.Sprintf(" (%dm)", w.DurationSec/60)
			}
			sb.WriteString(line + "\n")
		}
	}

	// Calculate streak from sessions only
	streak := domain.CalculateStreak(sessionStatuses)

	if streak > 0 {
		fmt.Fprintf(&sb,
			"\n🔥 **Current streak:** %d workout%s", streak, map[bool]string{true: "s", false: ""}[streak != 1])
	}

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}
