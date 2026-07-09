package bot

import (
	"log/slog"
	"time"
)

// userLocation returns the time.Location for the stored user timezone,
// falling back to the system timezone when unavailable or invalid. The nil
// guard on b.timezone matters for unit tests that build a partial Bot
// fixture without wiring the timezone store.
func (b *Bot) userLocation() *time.Location {
	if b.timezone == nil {
		return time.Local
	}
	tz, err := b.timezone.GetCurrent()
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
