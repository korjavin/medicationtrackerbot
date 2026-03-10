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

	pending, err := c.store.GetPendingIntakes()
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

			med, err := c.store.GetMedication(p.MedicationID)
			if err != nil {
				continue
			}
			if med == nil {
				continue
			}

			text := fmt.Sprintf("🔔 REMINDER: You haven't confirmed taking %s (%s) yet on %s!",
				med.Name, med.Dosage, scheduledAt.Format("15:04"))

			intakeID := p.ID
			actions := []notifier.Action{
				{ID: "confirm_intake:" + strconv.FormatInt(p.ID, 10), Label: "✅ Confirm Intake"},
			}
			if med.Supplement {
				actions = append(actions, notifier.Action{
					ID:    "skip_intake:" + strconv.FormatInt(p.ID, 10),
					Label: "⏭ Skip",
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
				if err := c.store.AddIntakeReminder(intakeID, msgID); err != nil {
					slog.Error("Failed to store intake reminder", "error", err)
				}
			})
		}
	}
	return nil
}
