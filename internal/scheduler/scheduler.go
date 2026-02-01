package scheduler

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/webpush"
)

type Scheduler struct {
	store             *store.Store
	bot               *bot.Bot
	allowedUserID     int64
	lastLowStockCheck time.Time
	webPush           *webpush.Service
}

func New(store *store.Store, bot *bot.Bot, allowedUserID int64, webPush *webpush.Service) *Scheduler {
	return &Scheduler{
		store:         store,
		bot:           bot,
		allowedUserID: allowedUserID,
		webPush:       webPush,
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
}

func (s *Scheduler) checkSchedule() error {
	now := time.Now()
	// Truncate to minute to avoid sub-minute drifts if needed, but DB comparison handles equality.
	// Actually, store stores time.Time. SQLite driver stores it as string usually or timestamp.
	// For idempotency, we should standardise the "Scheduled At" time we insert.
	// It should be Today + HH:MM:00 (zero seconds).

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

		// 1. Create Pending Logs for ALL in group
		for _, med := range group.Meds {
			log.Printf("Triggering medication %s (%s) scheduled for %s", med.Name, med.Dosage, med.Schedule)
			_, err := s.store.CreateIntake(med.ID, s.allowedUserID, group.Target)
			if err != nil {
				log.Printf("Failed to create intake log: %v", err)
				// Continue? If fail, it won't be confirmable.
			}
		}

		// 2. Send Group Notification
		if err := s.bot.SendGroupNotification(group.Meds, group.Target); err != nil {
			log.Printf("Failed to send group notification: %v", err)
		}

		// 3. Send Web Push
		if s.webPush != nil {
			ctx := context.Background()
			if err := s.webPush.SendMedicationNotification(ctx, s.allowedUserID, group.Meds, group.Target); err != nil {
				log.Printf("Failed to send Web Push: %v", err)
			}
		}
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

			msgID, err := s.bot.SendNotification(text, med.ID)
			if err != nil {
				log.Printf("Failed to send reminder: %v", err)
			} else {
				s.store.AddIntakeReminder(p.ID, msgID)
			}
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

	for _, m := range meds {
		daysRemaining := s.store.GetDaysOfStockRemaining(&m)
		daysStr := ""
		if daysRemaining != nil {
			daysStr = fmt.Sprintf(" (~%.0f days left)", *daysRemaining)
		}
		sb += fmt.Sprintf("• **%s**: %d units%s\n", m.Name, *m.InventoryCount, daysStr)
	}

	sb += "\nPlease restock soon!"

	if err := s.bot.SendLowStockWarning(sb); err != nil {
		log.Printf("Failed to send low stock warning: %v", err)
	}

	if s.webPush != nil {
		ctx := context.Background()
		if err := s.webPush.SendLowStockNotification(ctx, s.allowedUserID, meds); err != nil {
			log.Printf("Failed to send Web Push low stock: %v", err)
		}
	}

	s.lastLowStockCheck = time.Now()
}
