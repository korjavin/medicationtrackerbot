package scheduler

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// LowStockChecker sends daily low-stock warnings around 11 AM.
type LowStockChecker struct {
	NotifyHelper
	store     MedicationStore
	lastCheck time.Time
}

func (c *LowStockChecker) Check(_ context.Context) error {
	now := time.Now()

	// Only send warnings between 11:00 and 11:59 AM
	if now.Hour() != 11 {
		return nil
	}

	// Only check once per day
	if !c.lastCheck.IsZero() {
		lastCheckDate := time.Date(c.lastCheck.Year(), c.lastCheck.Month(), c.lastCheck.Day(), 0, 0, 0, 0, c.lastCheck.Location())
		todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if !lastCheckDate.Before(todayDate) {
			return nil
		}
	}

	meds, err := c.store.GetMedicationsLowOnStock(7)
	if err != nil {
		log.Printf("Error checking low stock: %v", err)
		return nil
	}

	if len(meds) == 0 {
		c.lastCheck = time.Now()
		return nil
	}

	var sb string
	sb = "⚠️ **Low Stock Warning**\n\nThe following medications are running low (< 7 days):\n\n"

	for _, m := range meds {
		daysRemaining := c.store.GetDaysOfStockRemaining(&m)
		daysStr := ""
		if daysRemaining != nil {
			daysStr = fmt.Sprintf(" (~%.0f days left)", *daysRemaining)
		}
		sb += fmt.Sprintf("• **%s**: %d units%s\n", m.Name, *m.InventoryCount, daysStr)
	}

	sb += "\nPlease restock soon!"

	n := notifier.Notification{
		Text: sb,
		Tag:  "low-stock",
		Metadata: map[string]interface{}{
			"type": "low_stock",
		},
	}

	c.Notify(context.Background(), n, nil)

	c.lastCheck = time.Now()
	return nil
}
