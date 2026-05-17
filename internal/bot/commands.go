package bot

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
