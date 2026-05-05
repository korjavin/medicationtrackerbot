package seeddemo

import "time"

// clock walks deterministic times across the synthetic window. The window
// runs from `start` (anchor minus `days`) up to `anchor`. All helpers use
// UTC so generated rows are reproducible regardless of the host TZ.
type clock struct {
	anchor time.Time
	start  time.Time
	days   int
}

func newClock(anchor time.Time, days int) *clock {
	a := anchor.UTC()
	return &clock{
		anchor: a,
		start:  a.AddDate(0, 0, -days),
		days:   days,
	}
}

// dayOffset returns midnight UTC of the day `offset` days from the start
// of the window. offset=0 is the first day; offset=days-1 is the day
// before the anchor.
func (c *clock) dayOffset(offset int) time.Time {
	d := c.start.AddDate(0, 0, offset)
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
}

// at returns the moment at the given hour:minute on the day at offset.
func (c *clock) at(offset, hour, minute int) time.Time {
	d := c.dayOffset(offset)
	return time.Date(d.Year(), d.Month(), d.Day(), hour, minute, 0, 0, time.UTC)
}

// daysFromAnchor returns the moment exactly `n` days before the anchor
// (n positive = past). n=0 is the anchor itself.
func (c *clock) daysFromAnchor(n int) time.Time {
	return c.anchor.AddDate(0, 0, -n)
}
