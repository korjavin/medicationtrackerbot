package bot

// gamification_commands.go: the bot half of "one read model, two
// presentations" (gamification-12 Overview) — /week formats the same
// WeeklyReview the Journey "Your week" card renders, independently phrased
// (Technical Details: no shared template layer between web and bot). The
// scheduled Sunday digest (Task 5) reuses FormatWeeklyReview so the two bot
// surfaces never drift.

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
)

// leverLabels mirrors journey.js's RINGS label map — duplicated rather than
// shared, same as the web card's independent phrasing.
var leverLabels = map[string]string{
	gamificationsvc.LeverBedtime:     "Bedtime",
	gamificationsvc.LeverMovement:    "Movement",
	gamificationsvc.LeverNourishment: "Nourishment",
}

var gaugePaceLabels = map[string]string{
	gamificationsvc.PaceStatusOnPace:         "on pace",
	gamificationsvc.PaceStatusTooSlow:        "slower than your pace",
	gamificationsvc.PaceStatusTooFast:        "faster than your pace",
	gamificationsvc.PaceStatusWrongDirection: "moving away from goal",
}

var gaugeAccelerationLabels = map[string]string{
	gamificationsvc.AccelerationSpeedingUp: "speeding up",
	gamificationsvc.AccelerationHolding:    "holding steady",
	gamificationsvc.AccelerationSlowing:    "slowing",
}

// handleWeekCommand handles /week. Thin channel: it only calls
// GetWeeklyReview and formats the structured result — the service applies
// the gamification_enabled gate and the quiet-week semantics, so this
// handler never branches on flags itself.
func (b *Bot) handleWeekCommand(msgConfig *tgbotapi.MessageConfig) {
	// Match the HTTP read path (ensureGamificationFresh): the ledger the lever
	// counts fold over is only materialized on first-enable backfill and on a
	// gamification read's rescore window, so a food/weight write that hasn't
	// been scored yet would otherwise read as missing here.
	now := time.Now().UTC()
	gamificationsvc.EnsureFresh(context.Background(), b.gamificationSvc, b.allowedUserID, now)

	wr, err := b.gamificationSvc.GetWeeklyReview(context.Background(), b.allowedUserID, now)
	if err != nil {
		slog.Error("get weekly review", "error", err, "user_id", b.allowedUserID)
		msgConfig.Text = "❌ Error retrieving your weekly review."
		return
	}
	msgConfig.Text = FormatWeeklyReview(wr)
}

// FormatWeeklyReview renders the WeeklyReview read model into the short
// digest text /week and the opt-in Sunday message share. Tone rules match
// the Journey card: neutral-to-positive phrasing only, a down week reads as
// observation, and a zero-HP week reads as "a quiet week" — every branch is
// a friendly one-liner, never a stack of zeros (Task 4).
func FormatWeeklyReview(wr gamificationsvc.WeeklyReview) string {
	if !wr.Enabled {
		return "🎮 Gamification is turned off in Settings."
	}
	if wr.Quiet {
		return "🗓 Your week\nA quiet week — everything picks up where you left off."
	}

	lines := []string{"🗓 Your week"}
	for _, line := range []string{
		weeklyScoreLine(wr.HealthScore),
		weeklyLeverLine(wr.Levers),
		weeklyWeightLine(wr.Gauges.Weight),
		weeklyBPLine(wr.Gauges.BP, wr.Gauges.BPShare30dPrior),
		weeklyRestingHRLine(wr.Gauges.RestingHR),
		weeklyBestDayLine(wr.BestDay),
	} {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func weeklyScoreLine(hs gamificationsvc.WeeklyHealthScore) string {
	if hs.Now.Value == nil {
		return ""
	}
	now := int(math.Round(*hs.Now.Value))
	if hs.Prior.Value == nil {
		return fmt.Sprintf("Health Score %d", now)
	}
	prior := int(math.Round(*hs.Prior.Value))
	delta := now - prior
	switch {
	case delta == 0:
		return fmt.Sprintf("Health Score %d · holding steady", now)
	case delta > 0:
		return fmt.Sprintf("Health Score %d · up %d", now, delta)
	default:
		return fmt.Sprintf("Health Score %d · down %d", now, -delta)
	}
}

func weeklyLeverLine(levers []gamificationsvc.WeeklyLeverReview) string {
	if len(levers) == 0 {
		return ""
	}
	parts := make([]string, 0, len(levers))
	for i, lv := range levers {
		label := leverLabels[lv.Key]
		if label == "" {
			label = lv.Key
		}
		if i == 0 {
			parts = append(parts, fmt.Sprintf("%s closed %d of 7", label, lv.ClosedThisWeek))
		} else {
			parts = append(parts, fmt.Sprintf("%s %d", label, lv.ClosedThisWeek))
		}
	}
	return strings.Join(parts, " · ")
}

func weeklyWeightLine(w gamificationsvc.WeightGaugeView) string {
	if w.Status != gamificationsvc.GaugeStatusOK {
		return ""
	}
	sign := ""
	if w.VelocityPctPerWeek >= 0 {
		sign = "+"
	}
	parts := []string{fmt.Sprintf("%s%.1f%%/wk", sign, w.VelocityPctPerWeek)}
	if pace := gaugePaceLabels[w.PaceStatus]; pace != "" {
		parts = append(parts, pace)
	}
	if accel := gaugeAccelerationLabels[w.Acceleration]; accel != "" {
		parts = append(parts, accel)
	}
	return "Weight " + strings.Join(parts, " · ")
}

func weeklyBPLine(bp gamificationsvc.BPGaugeView, priorShare float64) string {
	if bp.Status != gamificationsvc.GaugeStatusOK || bp.Count30d <= 0 {
		return ""
	}
	share := int(math.Round(bp.Share30d * 100))
	prior := int(math.Round(priorShare * 100))
	// No comparable prior week (too few readings a week ago yields a 0 share) →
	// show just the current share rather than a misleading "up from 0%".
	if prior <= 0 {
		return fmt.Sprintf("BP in range %d%%", share)
	}
	delta := share - prior
	word := "holding steady"
	switch {
	case delta > 0:
		word = fmt.Sprintf("up from %d%%", prior)
	case delta < 0:
		word = fmt.Sprintf("down from %d%%", prior)
	}
	return fmt.Sprintf("BP in range %d%% · %s", share, word)
}

func weeklyRestingHRLine(hr gamificationsvc.RestingHRGaugeView) string {
	if hr.Status != gamificationsvc.GaugeStatusOK {
		return ""
	}
	recent := int(math.Round(hr.Recent14dMean))
	delta := int(math.Round(hr.DeltaFromBaseline))
	deltaWord := "at your baseline"
	switch {
	case delta > 0:
		deltaWord = fmt.Sprintf("%d above your baseline", delta)
	case delta < 0:
		deltaWord = fmt.Sprintf("%d below your baseline", -delta)
	}
	return fmt.Sprintf("Resting HR %d avg · %s", recent, deltaWord)
}

func weeklyBestDayLine(bd *gamificationsvc.WeeklyBestDay) string {
	if bd == nil {
		return ""
	}
	day := time.Unix(bd.DayUnix, 0).UTC().Weekday().String()
	plural := "s"
	if bd.RingsClosed == 1 {
		plural = ""
	}
	return fmt.Sprintf("Best day: %s · %d ring%s closed", day, bd.RingsClosed, plural)
}
