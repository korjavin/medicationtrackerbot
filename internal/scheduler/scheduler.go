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

type Scheduler struct {
	store             *store.Store
	notifiers         []notifier.Notifier
	allowedUserID     int64
	lastLowStockCheck time.Time
}

func New(store *store.Store, allowedUserID int64, notifiers []notifier.Notifier) *Scheduler {
	return &Scheduler{
		store:         store,
		notifiers:     notifiers,
		allowedUserID: allowedUserID,
	}
}

// notify sends a notification through all configured notifiers.
// If storeMsgID is non-nil, the first non-zero message ID is passed to it.
func (s *Scheduler) notify(ctx context.Context, n notifier.Notification, storeMsgID func(int)) {
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			msgID, err := nr.Send(ctx, s.allowedUserID, n)
			if err != nil {
				log.Printf("Notification send failed (%T): %v", nr, err)
				return
			}
			if msgID != 0 && storeMsgID != nil {
				storeMsgID(msgID)
			}
		}(nr)
	}
}

// deleteNotification deletes a previously sent notification from all notifiers.
func (s *Scheduler) deleteNotification(ctx context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.Delete(ctx, s.allowedUserID, msgID); err != nil {
				log.Printf("Notification delete failed (%T): %v", nr, err)
			}
		}(nr)
	}
}

func (s *Scheduler) Start() {
	// Check every minute
	ticker := time.NewTicker(1 * time.Minute)
	go func() {
		for range ticker.C {
			if err := s.checkSchedule(); err != nil {
				log.Printf("Error checking schedule: %v", err)
			}
		}
	}()

	// Retry loop every 60 minutes
	retryTicker := time.NewTicker(60 * time.Minute)
	go func() {
		for range retryTicker.C {
			if err := s.checkReminders(); err != nil {
				log.Printf("Error checking reminders: %v", err)
			}
		}
	}()

	// Check low stock every hour, but only send warnings around 11 AM once per day
	lowStockTicker := time.NewTicker(1 * time.Hour)
	go func() {
		// Initial check after 1 minute
		time.Sleep(1 * time.Minute)
		s.checkLowStock()

		for range lowStockTicker.C {
			s.checkLowStock()
		}
	}()

	// Check workout notifications every minute
	workoutTicker := time.NewTicker(1 * time.Minute)
	go func() {
		for range workoutTicker.C {
			if err := s.checkWorkoutNotifications(); err != nil {
				log.Printf("Error checking workout notifications: %v", err)
			}
		}
	}()

	// Check BP reminders every 15 minutes
	bpReminderTicker := time.NewTicker(15 * time.Minute)
	go func() {
		// Initial check after 2 minutes
		time.Sleep(2 * time.Minute)
		if err := s.checkBPReminders(); err != nil {
			log.Printf("Error checking BP reminders: %v", err)
		}

		for range bpReminderTicker.C {
			if err := s.checkBPReminders(); err != nil {
				log.Printf("Error checking BP reminders: %v", err)
			}
		}
	}()

	// Check weight reminders every 30 minutes (less frequent than BP)
	weightReminderTicker := time.NewTicker(30 * time.Minute)
	go func() {
		// Initial check after 3 minutes (offset from BP checker)
		time.Sleep(3 * time.Minute)
		if err := s.checkWeightReminders(); err != nil {
			log.Printf("Error checking weight reminders: %v", err)
		}

		for range weightReminderTicker.C {
			if err := s.checkWeightReminders(); err != nil {
				log.Printf("Error checking weight reminders: %v", err)
			}
		}
	}()
}

func (s *Scheduler) checkSchedule() error {
	enabled, err := s.store.GetMedicationEnabled(context.Background())
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	now := time.Now()

	meds, err := s.store.ListMedications(false)
	if err != nil {
		return err
	}

	// Group By Target Time
	type NotificationGroup struct {
		Target time.Time
		Meds   []store.Medication
	}

	// Key: Unix timestamp of target time
	groups := make(map[int64]*NotificationGroup)

	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil {
			log.Printf("Invalid schedule for med %d: %v", med.ID, err)
			continue
		}

		// Skip if "as_needed"
		if cfg.Type == "as_needed" {
			continue
		}

		// If "weekly", check current day
		if cfg.Type == "weekly" {
			todayIdx := int(now.Weekday()) // 0=Sunday
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

		// Iterate over times
		for _, timeStr := range cfg.Times {
			if len(timeStr) != 5 {
				continue
			}
			hour, _ := strconv.Atoi(timeStr[:2])
			minute, _ := strconv.Atoi(timeStr[3:])

			target := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())

			// Logic:
			// 1a. Check Start/End Dates
			if med.StartDate != nil && target.Before(*med.StartDate) {
				// Not yet active
				continue
			}
			if med.EndDate != nil && target.After(*med.EndDate) {
				// Period ended
				continue
			}

			// 1b. If Now is BEFORE target, we wait.
			if now.Before(target) {
				continue
			}

			// 2. Check if log exists
			existing, err := s.store.GetIntakeBySchedule(med.ID, target)
			if err != nil {
				log.Printf("Error checking intake existence: %v", err)
				continue
			}

			if existing == nil {
				// Add to Group
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

	// Process Groups
	for _, group := range groups {
		if len(group.Meds) == 0 {
			continue
		}

		// Create Intakes for all meds in group
		var intakeIDs []int64
		for _, med := range group.Meds {
			log.Printf("Triggering medication %s (%s) scheduled for %s", med.Name, med.Dosage, med.Schedule)
			id, err := s.store.CreateIntake(med.ID, s.allowedUserID, group.Target)
			if err != nil {
				log.Printf("Failed to create intake log: %v", err)
			} else {
				intakeIDs = append(intakeIDs, id)
			}
		}

		// Build notification text
		text := fmt.Sprintf("💊 Time to take your medications (%s):\n\n", group.Target.Format("15:04"))
		for _, m := range group.Meds {
			if m.Dosage != "" {
				text += fmt.Sprintf("- %s (%s)\n", m.Name, m.Dosage)
			} else {
				text += fmt.Sprintf("- %s\n", m.Name)
			}
		}

		// Build actions: individual confirm buttons + confirm all
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
		s.notify(context.Background(), n, func(msgID int) {
			for _, iID := range iIDs {
				if err := s.store.AddIntakeReminder(iID, msgID); err != nil {
					log.Printf("Failed to add intake reminder for int %d msg %d: %v", iID, msgID, err)
				}
			}
		})
	}

	return nil
}

func (s *Scheduler) checkReminders() error {
	pending, err := s.store.GetPendingIntakes()
	if err != nil {
		return err
	}

	for _, p := range pending {
		scheduledAt := p.ScheduledAt
		if time.Since(scheduledAt) > 1*time.Hour {
			// Send reminder
			med, err := s.store.GetMedication(p.MedicationID)
			if err != nil {
				continue
			}
			if med == nil { // deleted?
				continue
			}

			text := fmt.Sprintf("🔔 REMINDER: You haven't confirmed taking %s (%s) yet on %s!",
				med.Name, med.Dosage, scheduledAt.Format("15:04"))

			intakeID := p.ID
			n := notifier.Notification{
				Text: text,
				Actions: []notifier.Action{
					{ID: "confirm_intake:" + strconv.FormatInt(p.ID, 10), Label: "✅ Confirm Intake"},
				},
				Tag: fmt.Sprintf("medication-reminder-%d", p.ID),
				Metadata: map[string]interface{}{
					"type":      "medication_reminder",
					"intake_id": p.ID,
				},
			}

			s.notify(context.Background(), n, func(msgID int) {
				if err := s.store.AddIntakeReminder(intakeID, msgID); err != nil {
					log.Printf("Failed to store intake reminder: %v", err)
				}
			})
		}
	}
	return nil
}

func (s *Scheduler) checkLowStock() {
	now := time.Now()

	// Only send warnings between 11:00 and 11:59 AM
	if now.Hour() != 11 {
		return
	}

	// Only check once per day - compare dates instead of duration
	if !s.lastLowStockCheck.IsZero() {
		lastCheckDate := time.Date(s.lastLowStockCheck.Year(), s.lastLowStockCheck.Month(), s.lastLowStockCheck.Day(), 0, 0, 0, 0, s.lastLowStockCheck.Location())
		todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if !lastCheckDate.Before(todayDate) {
			// Already sent today
			return
		}
	}

	meds, err := s.store.GetMedicationsLowOnStock(7)
	if err != nil {
		log.Printf("Error checking low stock: %v", err)
		return
	}

	if len(meds) == 0 {
		s.lastLowStockCheck = time.Now()
		return
	}

	// Build warning message
	var sb string
	sb = "⚠️ **Low Stock Warning**\n\nThe following medications are running low (< 7 days):\n\n"

	medNames := make([]string, len(meds))
	for i, m := range meds {
		daysRemaining := s.store.GetDaysOfStockRemaining(&m)
		daysStr := ""
		if daysRemaining != nil {
			daysStr = fmt.Sprintf(" (~%.0f days left)", *daysRemaining)
		}
		sb += fmt.Sprintf("• **%s**: %d units%s\n", m.Name, *m.InventoryCount, daysStr)
		medNames[i] = m.Name
	}

	sb += "\nPlease restock soon!"

	n := notifier.Notification{
		Text: sb,
		Tag:  "low-stock",
		Metadata: map[string]interface{}{
			"type": "low_stock",
		},
	}

	s.notify(context.Background(), n, nil)

	s.lastLowStockCheck = time.Now()
}
