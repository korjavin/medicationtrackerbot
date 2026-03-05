package scheduler

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// MedicationReminderChecker re-sends reminders for unconfirmed intakes.
type MedicationReminderChecker struct {
	NotifyHelper
	store MedicationStore
}

func (c *MedicationReminderChecker) Check(ctx context.Context) error {
	pending, err := c.store.GetPendingIntakes()
	if err != nil {
		return err
	}

	for _, p := range pending {
		scheduledAt := p.ScheduledAt
		if time.Since(scheduledAt) > 1*time.Hour {
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
				Tag: fmt.Sprintf("medication-reminder-%d", p.ID),
				Metadata: map[string]interface{}{
					"type":      "medication_reminder",
					"intake_id": p.ID,
				},
			}

			c.Notify(ctx, n, func(msgID int) {
				if err := c.store.AddIntakeReminder(intakeID, msgID); err != nil {
					log.Printf("Failed to store intake reminder: %v", err)
				}
			})
		}
	}
	return nil
}
