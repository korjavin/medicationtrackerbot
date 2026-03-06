package scheduler

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MedicationStore is the subset of store operations needed for medication scheduling.
type MedicationStore interface {
	GetMedicationEnabled(ctx context.Context) (bool, error)
	ListMedications(archived bool) ([]store.Medication, error)
	GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error)
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	AddIntakeReminder(intakeID int64, msgID int) error
	GetPendingIntakes() ([]store.IntakeLog, error)
	GetMedication(id int64) (*store.Medication, error)
	GetMedicationsLowOnStock(days int) ([]store.Medication, error)
	GetDaysOfStockRemaining(med *store.Medication) *float64
}

// MedicationChecker checks for due medications and sends notifications.
type MedicationChecker struct {
	NotifyHelper
	store MedicationStore
	now   func() time.Time // injectable clock; defaults to time.Now
}

func (c *MedicationChecker) Check(ctx context.Context) error {
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
	now := c.now()

	meds, err := c.store.ListMedications(false)
	if err != nil {
		return err
	}

	// Group By Target Time
	type NotificationGroup struct {
		Target time.Time
		Meds   []store.Medication
	}

	groups := make(map[int64]*NotificationGroup)

	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil {
			log.Printf("Invalid schedule for med %d: %v", med.ID, err)
			continue
		}

		if cfg.Type == "as_needed" {
			continue
		}

		if cfg.Type == "weekly" {
			todayIdx := int(now.Weekday())
			found := false
			for _, d := range cfg.Days {
				if d == todayIdx {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		for _, timeStr := range cfg.Times {
			if len(timeStr) != 5 {
				continue
			}
			hour, _ := strconv.Atoi(timeStr[:2])
			minute, _ := strconv.Atoi(timeStr[3:])

			target := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())

			if med.StartDate != nil && target.Before(*med.StartDate) {
				continue
			}
			if med.EndDate != nil && target.After(*med.EndDate) {
				continue
			}

			if now.Before(target) {
				continue
			}

			existing, err := c.store.GetIntakeBySchedule(med.ID, target)
			if err != nil {
				log.Printf("Error checking intake existence: %v", err)
				continue
			}

			if existing == nil {
				ts := target.Unix()
				if _, ok := groups[ts]; !ok {
					groups[ts] = &NotificationGroup{
						Target: target,
						Meds:   []store.Medication{},
					}
				}
				groups[ts].Meds = append(groups[ts].Meds, med)
			}
		}
	}

	for _, group := range groups {
		if len(group.Meds) == 0 {
			continue
		}

		var intakeIDs []int64
		for _, med := range group.Meds {
			log.Printf("Triggering medication %s (%s) scheduled for %s", med.Name, med.Dosage, med.Schedule)
			id, err := c.store.CreateIntake(med.ID, c.allowedUserID, group.Target)
			if err != nil {
				log.Printf("Failed to create intake log: %v", err)
			} else {
				intakeIDs = append(intakeIDs, id)
			}
		}

		text := fmt.Sprintf("💊 Time to take your medications (%s):\n\n", group.Target.Format("15:04"))
		for _, m := range group.Meds {
			if m.Dosage != "" {
				text += fmt.Sprintf("- %s (%s)\n", m.Name, m.Dosage)
			} else {
				text += fmt.Sprintf("- %s\n", m.Name)
			}
		}

		intakeByMedication := make(map[int64]int64, len(group.Meds))
		for i := 0; i < len(group.Meds) && i < len(intakeIDs); i++ {
			intakeByMedication[group.Meds[i].ID] = intakeIDs[i]
		}

		var actions []notifier.Action
		for _, m := range group.Meds {
			data := "confirm:" + strconv.FormatInt(m.ID, 10)
			if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
				data = "confirm_intake:" + strconv.FormatInt(intakeID, 10)
			}
			actions = append(actions, notifier.Action{ID: data, Label: "Take " + m.Name})
			if m.Supplement {
				if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
					actions = append(actions, notifier.Action{
						ID:    "skip_intake:" + strconv.FormatInt(intakeID, 10),
						Label: "Skip " + m.Name,
					})
				}
			}
		}
		actions = append(actions, notifier.Action{
			ID:    "confirm_schedule:" + strconv.FormatInt(group.Target.Unix(), 10),
			Label: "✅✅ Confirm ALL",
		})

		medNames := make([]string, len(group.Meds))
		medIDs := make([]int64, len(group.Meds))
		for i, m := range group.Meds {
			name := m.Name
			if m.Dosage != "" {
				name += " " + m.Dosage
			}
			medNames[i] = name
			medIDs[i] = m.ID
		}

		n := notifier.Notification{
			Text:    text,
			Actions: actions,
			Tag:     fmt.Sprintf("medication-%s", group.Target.Format(time.RFC3339)),
			Metadata: map[string]interface{}{
				"type":             "medication",
				"scheduled_at":     group.Target.Format(time.RFC3339),
				"medication_ids":   medIDs,
				"medication_names": medNames,
				"intake_ids":       intakeIDs,
			},
		}

		iIDs := intakeIDs
		c.Notify(ctx, n, func(msgID int) {
			for _, iID := range iIDs {
				if err := c.store.AddIntakeReminder(iID, msgID); err != nil {
					log.Printf("Failed to add intake reminder for int %d msg %d: %v", iID, msgID, err)
				}
			}
		})
	}

	return nil
}
