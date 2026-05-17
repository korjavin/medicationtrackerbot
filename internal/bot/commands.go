package bot

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// commandSpec is the canonical metadata for a single slash command. The same
// spec drives /help rendering and the Telegram setMyCommands menu so the two
// surfaces never drift apart.
//
// Name is the command without the leading slash. Description must fit within
// Telegram's 256-char limit and is shown verbatim in the autocomplete menu.
// Section is the /help grouping header. EnabledIf returns whether the command
// should be exposed given a featureFlags snapshot; a nil EnabledIf means the
// command is always enabled.
type commandSpec struct {
	Name        string
	Description string
	Section     string
	EnabledIf   func(featureFlags) bool
}

// commandSections is the canonical order in which sections appear in /help
// output and (where relevant) the Telegram menu. Keep aligned with the
// section labels used in commandSpecs entries below.
var commandSections = []string{
	"General",
	"Medication Commands",
	"Blood Pressure & Weight",
	"Workout Commands",
	"Food Commands",
	"Notes",
	"Timezone",
}

// commandSpecs is the single source of truth for every slash command the bot
// routes. Every name here must have a matching case in handleMessage's switch
// (see bot.go), and vice versa — TestCommandSpecs_CoversEveryRoutedCommand
// enforces both directions.
var commandSpecs = []commandSpec{
	// General — always enabled regardless of feature flags so onboarding and
	// help work even when every domain section is toggled off.
	{Name: "start", Description: "Start the bot and open the App", Section: "General"},
	{Name: "help", Description: "Show available commands", Section: "General"},

	// Medication.
	{Name: "log", Description: "Manually log a dose for any medication", Section: "Medication Commands",
		EnabledIf: func(f featureFlags) bool { return f.Medication }},
	{Name: "next", Description: "Trigger notification for next scheduled medication", Section: "Medication Commands",
		EnabledIf: func(f featureFlags) bool { return f.Medication }},
	{Name: "stock", Description: "View medication inventory status", Section: "Medication Commands",
		EnabledIf: func(f featureFlags) bool { return f.Medication }},
	{Name: "download", Description: "Export medication, BP, and weight history to CSV", Section: "Medication Commands",
		EnabledIf: func(f featureFlags) bool { return f.Medication }},

	// Blood Pressure & Weight.
	{Name: "bp", Description: "Log blood pressure (systolic diastolic [pulse])", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.BP }},
	{Name: "bphistory", Description: "View recent blood pressure history (last 10 readings)", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.BP }},
	{Name: "bpstats", Description: "View blood pressure statistics (30-day averages)", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.BP }},
	{Name: "bpgoal", Description: "Set blood pressure goal (systolic diastolic)", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.BP }},
	{Name: "weight", Description: "Log weight in kilograms", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.Weight }},
	{Name: "weighthistory", Description: "View recent weight history (last 10 entries)", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.Weight }},
	{Name: "goal", Description: "Set weight goal (weight date)", Section: "Blood Pressure & Weight",
		EnabledIf: func(f featureFlags) bool { return f.Weight }},

	// Workout.
	{Name: "workout", Description: "Start an ad-hoc (unscheduled) workout", Section: "Workout Commands",
		EnabledIf: func(f featureFlags) bool { return f.Workout }},
	{Name: "startnext", Description: "Manually start next scheduled workout", Section: "Workout Commands",
		EnabledIf: func(f featureFlags) bool { return f.Workout }},
	{Name: "workoutstatus", Description: "View today's workout status", Section: "Workout Commands",
		EnabledIf: func(f featureFlags) bool { return f.Workout }},
	{Name: "workouthistory", Description: "View recent workouts and your streak", Section: "Workout Commands",
		EnabledIf: func(f featureFlags) bool { return f.Workout }},
	{Name: "activity", Description: "Log any activity in natural language", Section: "Workout Commands",
		EnabledIf: func(f featureFlags) bool { return f.Workout }},

	// Food.
	{Name: "intake", Description: "Log food intake (carbs protein fat weight [name])", Section: "Food Commands",
		EnabledIf: func(f featureFlags) bool { return f.Food }},
	{Name: "food", Description: "Log food using natural language", Section: "Food Commands",
		EnabledIf: func(f featureFlags) bool { return f.Food }},

	// Notes.
	{Name: "note", Description: "Save a personal diary note", Section: "Notes"},

	// Timezone.
	{Name: "tz", Description: "Set your timezone by sharing your location", Section: "Timezone"},
}

// enabledSpecs returns the subset of commandSpecs whose EnabledIf predicate
// matches the given flags (specs with a nil predicate are always included).
// Order is preserved from commandSpecs.
func enabledSpecs(flags featureFlags) []commandSpec {
	out := make([]commandSpec, 0, len(commandSpecs))
	for _, s := range commandSpecs {
		if s.EnabledIf == nil || s.EnabledIf(flags) {
			out = append(out, s)
		}
	}
	return out
}

// registerCommands pushes the current feature-flag-filtered command list to
// Telegram's setMyCommands endpoint so the slash-command autocomplete menu
// mirrors what /help shows. Telegram replaces the full list on each call, so
// repeated invocations are safe and idempotent.
func (b *Bot) registerCommands(ctx context.Context) error {
	flags := b.getFeatureFlags(ctx)
	specs := enabledSpecs(flags)
	cmds := make([]tgbotapi.BotCommand, 0, len(specs))
	for _, s := range specs {
		cmds = append(cmds, tgbotapi.BotCommand{
			Command:     s.Name,
			Description: s.Description,
		})
	}
	cfg := tgbotapi.NewSetMyCommands(cmds...)
	resp, err := b.api.Request(cfg)
	if err != nil {
		return err
	}
	if !resp.Ok {
		return fmt.Errorf("setMyCommands returned not-ok: %s", resp.Description)
	}
	return nil
}

// watchSettingsChanges polls the settings change_events stream and re-registers
// the Telegram slash-command menu whenever a "settings" tag appears, so the
// menu stays in sync with feature-flag toggles done in the web UI. Initial
// register happens in Start() before this watcher starts, so the cursor is
// seeded with "now" — events older than startup are ignored.
//
// Errors are logged and swallowed: a single failed tick must not stop the
// watcher (or the bot) from picking up the next event. Returns when ctx is
// cancelled.
func (b *Bot) watchSettingsChanges(ctx context.Context, interval time.Duration) {
	cursor, err := b.settingsChanges.GetLatestChangeCursor(ctx)
	if err != nil {
		slog.Warn("settings watcher: failed to read initial cursor", "error", err)
		cursor = 0
	}
	b.pollSettingsChanges(ctx, interval, cursor)
}

// pollSettingsChanges runs the watcher's polling loop starting from the given
// cursor. Separated from watchSettingsChanges so tests can seed the cursor
// synchronously and then race-free toggle a setting before the loop reads.
func (b *Bot) pollSettingsChanges(ctx context.Context, interval time.Duration, cursor int64) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			newCursor, tags, err := b.settingsChanges.ListChangedTagsSince(ctx, cursor)
			if err != nil {
				slog.Warn("settings watcher: list changes failed", "error", err)
				continue
			}
			cursor = newCursor
			if !containsSettingsTag(tags) {
				continue
			}
			if err := b.registerCommands(ctx); err != nil {
				slog.Warn("settings watcher: re-register commands failed", "error", err)
			}
		}
	}
}

func containsSettingsTag(tags []string) bool {
	for _, t := range tags {
		if t == "settings" {
			return true
		}
	}
	return false
}
