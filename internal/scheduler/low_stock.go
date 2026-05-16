package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// LowStockChecker sends daily low-stock warnings around 11 AM.
type LowStockChecker struct {
	NotifyHelper
	store     MedicationStore
	mu        sync.Mutex
	lastCheck time.Time
	now       func() time.Time // injectable clock; defaults to time.Now
}

func (c *LowStockChecker) Check(_ context.Context) error {
	// Resolve clock into a local — avoid mutating c.now so Check is safe
	// to call concurrently (the mutex below guards lastCheck, not c.now).
	nowFn := c.now
	if nowFn == nil {
		nowFn = time.Now
	}

	// Load user timezone — same pattern as bp_reminders.go:49-67.
	userLoc := time.Local
	if tz, err := c.store.GetCurrent(); err != nil {
		slog.Warn("low_stock: failed to get user timezone, using system TZ", "error", err)
	} else if tz != "" {
		if loc, err := time.LoadLocation(tz); err != nil {
			slog.Warn("low_stock: invalid user timezone, using system TZ", "tz", tz, "error", err)
		} else {
			userLoc = loc
		}
	}

	now := nowFn().In(userLoc)

	// Only send warnings between 11:00 and 11:59 AM in the user's timezone.
	if now.Hour() != 11 {
		return nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Only check once per day (date comparison in user TZ).
	if !c.lastCheck.IsZero() {
		last := c.lastCheck.In(userLoc)
		lastDate := time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, userLoc)
		todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, userLoc)
		if !lastDate.Before(todayDate) {
			return nil
		}
	}

	meds, err := c.store.ListLowOnStock(7)
	if err != nil {
		slog.Error("Error checking low stock", "error", err)
		return nil
	}

	if len(meds) == 0 {
		c.lastCheck = now
		return nil
	}

	var sb strings.Builder
	sb.WriteString("⚠️ **Low Stock Warning**\n\nThe following medications are running low (< 7 days):\n\n")

	for _, m := range meds {
		daysRemaining := c.store.GetDaysOfStockRemaining(&m)
		daysStr := ""
		if daysRemaining != nil {
			daysStr = fmt.Sprintf(" (~%.0f days left)", *daysRemaining)
		}
		sb.WriteString(fmt.Sprintf("• **%s**: %d units%s\n", m.Name, *m.InventoryCount, daysStr))
	}

	sb.WriteString("\nPlease restock soon!")

	n := notifier.Notification{
		Text: sb.String(),
		Tag:  "low-stock",
		Metadata: map[string]interface{}{
			"type": "low_stock",
		},
	}

	c.Notify(context.Background(), n, nil)

	c.lastCheck = now
	return nil
}
