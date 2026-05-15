package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// MedicationReminderChecker re-sends reminders for unconfirmed intakes.
type MedicationReminderChecker struct {
	NotifyHelper
	store MedicationStore
	now   func() time.Time // injectable clock; defaults to time.Now
}

func (c *MedicationReminderChecker) Check(ctx context.Context) error {
	enabled, err := c.store.GetMedicationEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	if c.now == nil {
		c.now = time.Now
	}

	// Resolve the user's stored timezone so reminder text formats the
	// scheduled_at in the locale the user actually sees on their phone.
	// Without this the reminder body would print the UTC clock time —
	// hence the "21:18 instead of 14:18 PDT" mismatch the user reported
	// for unconfirmed transition-step intakes.
	userLoc := time.Local
	if tz, tzErr := c.store.GetCurrentTimezone(); tzErr != nil {
		slog.Warn("medication reminder: failed to load timezone, formatting in system TZ", "error", tzErr)
	} else if tz != "" {
		if loc, locErr := time.LoadLocation(tz); locErr != nil {
			slog.Warn("medication reminder: invalid timezone, formatting in system TZ", "tz", tz, "error", locErr)
		} else {
			userLoc = loc
		}
	}

	pending, err := c.store.ListPendingIntakes()
	if err != nil {
		return err
	}

	for _, p := range pending {
		scheduledAt := p.ScheduledAt
		now := c.now()

		shouldRemind := false
		if p.SnoozedUntil != nil {
			// If snoozed_until is in the past, it means the snooze expired, remind immediately
			if now.After(*p.SnoozedUntil) {
				shouldRemind = true
			}
		} else {
			// Original logic: remind if > 1 hour after scheduled
			if now.Sub(scheduledAt) > 1*time.Hour {
				shouldRemind = true
			}
		}

		if shouldRemind {
			// If we just reminded them because snooze expired, we should update snoozed_until
			// or clear it so we don't spam them on every tick?
			// Actually, if we don't update anything, the checker will keep reminding them on every tick!
			// We can clear SnoozedUntil or push it another hour so it acts like a re-reminder.
			// Let's advance it by 1 hour automatically after firing so they get another reminder in an hour if still pending.
			if p.SnoozedUntil != nil && now.After(*p.SnoozedUntil) {
				newSnooze := now.Add(1 * time.Hour)
				if err := c.store.SnoozeIntake(p.ID, newSnooze); err != nil {
					slog.Error("Failed to update snooze_until after reminding", "error", err)
				}
			} else if p.SnoozedUntil == nil {
				// Also advance snoozed_until so the 1-hour regular reminder doesn't fire every minute
				newSnooze := now.Add(1 * time.Hour)
				if err := c.store.SnoozeIntake(p.ID, newSnooze); err != nil {
					slog.Error("Failed to update snooze_until after reminding", "error", err)
				}
			}

			med, err := c.store.Get(p.MedicationID)
			if err != nil {
				continue
			}
			if med == nil {
				continue
			}

			text := fmt.Sprintf("🔔 REMINDER: You haven't confirmed taking %s (%s) yet on %s!",
				med.Name, med.Dosage, scheduledAt.In(userLoc).Format("15:04"))

			intakeID := p.ID
			actions := []notifier.Action{
				{ID: "confirm_intake:" + strconv.FormatInt(p.ID, 10), Label: "✅ Confirm Intake"},
			}
			actions = append(actions, notifier.Action{
				ID:    "skip_intake:" + strconv.FormatInt(p.ID, 10),
				Label: "⏭ Skip",
			})
			// Show "Silence 24h" button starting from the second reminder (when snoozed_until is already set)
			if p.SnoozedUntil != nil {
				actions = append(actions, notifier.Action{
					ID:    "silence_intake:" + strconv.FormatInt(p.ID, 10),
					Label: "🔕 Silence 24h",
				})
			}

			n := notifier.Notification{
				Text:    text,
				Actions: actions,
				Tag:     fmt.Sprintf("medication-reminder-%d", p.ID),
				Metadata: map[string]interface{}{
					"type":      "medication_reminder",
					"intake_id": p.ID,
				},
			}

			c.Notify(ctx, n, func(msgID int) {
				if err := c.store.CreateIntakeReminder(intakeID, msgID); err != nil {
					slog.Error("Failed to store intake reminder", "error", err)
				}
			})
		}
	}
	return nil
}
