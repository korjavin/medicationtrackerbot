package bot

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// routedCommands is the canonical list of slash commands the bot dispatches
// in handleMessage (bot.go switch on msg.Command) plus the implicit /start
// command Telegram clients send on first chat. Keep in sync with bot.go and
// with commandSpecs.
var routedCommands = []string{
	"start", "help",
	"log", "download", "bp", "bphistory", "bpstats",
	"weight", "weighthistory", "goal", "bpgoal", "stock",
	"workout", "startnext", "workoutstatus", "workouthistory",
	"next", "intake", "food", "activity", "note", "tz",
}

func TestCommandSpecs_CoversEveryRoutedCommand(t *testing.T) {
	specByName := map[string]commandSpec{}
	for _, s := range commandSpecs {
		if _, dup := specByName[s.Name]; dup {
			t.Errorf("duplicate commandSpec for %q", s.Name)
		}
		specByName[s.Name] = s
	}

	expected := map[string]bool{}
	for _, n := range routedCommands {
		expected[n] = true
		if _, ok := specByName[n]; !ok {
			t.Errorf("commandSpecs missing %q (routed in bot.go but no spec entry)", n)
		}
	}

	for _, s := range commandSpecs {
		if !expected[s.Name] {
			t.Errorf("commandSpecs contains %q but no router case exists for it in bot.go", s.Name)
		}
	}

	// Sanity: every spec must list a section, and the section must appear in
	// commandSections so /help ordering is deterministic.
	knownSection := map[string]bool{}
	for _, sec := range commandSections {
		knownSection[sec] = true
	}
	for _, s := range commandSpecs {
		if s.Section == "" {
			t.Errorf("commandSpec %q has empty Section", s.Name)
			continue
		}
		if !knownSection[s.Section] {
			t.Errorf("commandSpec %q has Section %q not declared in commandSections", s.Name, s.Section)
		}
	}
}

func TestEnabledSpecs_FiltersByFlag(t *testing.T) {
	all := featureFlags{Medication: true, BP: true, Weight: true, Workout: true, Food: true}

	cases := []struct {
		name        string
		flags       featureFlags
		wantPresent []string
		wantAbsent  []string
	}{
		{
			name:        "all flags enabled exposes every command",
			flags:       all,
			wantPresent: routedCommands,
		},
		{
			name:        "Medication off hides medication commands",
			flags:       featureFlags{BP: true, Weight: true, Workout: true, Food: true},
			wantAbsent:  []string{"log", "next", "stock", "download"},
			wantPresent: []string{"start", "help", "bp", "weight", "workout", "intake", "note", "tz"},
		},
		{
			name:        "BP off hides BP commands but keeps weight",
			flags:       featureFlags{Medication: true, Weight: true, Workout: true, Food: true},
			wantAbsent:  []string{"bp", "bphistory", "bpstats", "bpgoal"},
			wantPresent: []string{"weight", "weighthistory", "goal", "log", "workout"},
		},
		{
			name:        "Weight off hides weight commands but keeps BP",
			flags:       featureFlags{Medication: true, BP: true, Workout: true, Food: true},
			wantAbsent:  []string{"weight", "weighthistory", "goal"},
			wantPresent: []string{"bp", "bphistory", "bpstats", "bpgoal", "log"},
		},
		{
			name:        "Workout off hides workout commands including activity",
			flags:       featureFlags{Medication: true, BP: true, Weight: true, Food: true},
			wantAbsent:  []string{"workout", "startnext", "workoutstatus", "workouthistory", "activity"},
			wantPresent: []string{"log", "bp", "weight", "intake", "food"},
		},
		{
			name:        "Food off hides food commands",
			flags:       featureFlags{Medication: true, BP: true, Weight: true, Workout: true},
			wantAbsent:  []string{"intake", "food"},
			wantPresent: []string{"log", "bp", "weight", "workout", "note", "tz"},
		},
		{
			name:        "all flags off keeps only always-enabled commands",
			flags:       featureFlags{},
			wantPresent: []string{"start", "help", "note", "tz"},
			wantAbsent: []string{
				"log", "next", "stock", "download",
				"bp", "bphistory", "bpstats", "bpgoal",
				"weight", "weighthistory", "goal",
				"workout", "startnext", "workoutstatus", "workouthistory", "activity",
				"intake", "food",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := enabledSpecs(tc.flags)
			names := map[string]bool{}
			for _, s := range got {
				names[s.Name] = true
			}
			for _, w := range tc.wantPresent {
				if !names[w] {
					t.Errorf("expected %q in enabled specs, got: %v", w, sortedKeys(names))
				}
			}
			for _, w := range tc.wantAbsent {
				if names[w] {
					t.Errorf("expected %q absent from enabled specs, got: %v", w, sortedKeys(names))
				}
			}
		})
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestBuildHelpText_RendersFromCommandSpecs(t *testing.T) {
	b := &Bot{}
	all := featureFlags{Medication: true, BP: true, Weight: true, Workout: true, Food: true}
	text := b.buildHelpText(all)

	// Header line preserved.
	if !strings.Contains(text, "**Medication Tracker Bot**") {
		t.Errorf("expected header line in help text, got: %s", text)
	}

	// Footer preserved.
	if !strings.Contains(text, "**How to use:**") {
		t.Errorf("expected how-to-use footer in help text, got: %s", text)
	}

	// Every enabled command must appear as a `/<name> - <description>` line.
	for _, sp := range enabledSpecs(all) {
		line := "/" + sp.Name + " - " + sp.Description
		if !strings.Contains(text, line) {
			t.Errorf("expected line %q in help text, got: %s", line, text)
		}
	}

	// Section headers must appear for any section that has enabled specs and
	// must follow commandSections ordering.
	bySection := map[string][]commandSpec{}
	for _, sp := range enabledSpecs(all) {
		bySection[sp.Section] = append(bySection[sp.Section], sp)
	}
	lastIdx := -1
	for _, name := range commandSections {
		if len(bySection[name]) == 0 {
			continue
		}
		header := "**" + name + ":**"
		idx := strings.Index(text, header)
		if idx < 0 {
			t.Errorf("expected section header %q in help text", header)
			continue
		}
		if idx < lastIdx {
			t.Errorf("section %q appears out of order in help text", header)
		}
		lastIdx = idx
	}
}

func TestBuildHelpText_OmitsDisabledSections(t *testing.T) {
	b := &Bot{}

	cases := []struct {
		name              string
		flags             featureFlags
		wantHeaderAbsent  []string
		wantCommandAbsent []string
	}{
		{
			name:              "workout off omits workout section and commands",
			flags:             featureFlags{Medication: true, BP: true, Weight: true, Food: true},
			wantHeaderAbsent:  []string{"**Workout Commands:**"},
			wantCommandAbsent: []string{"/workout ", "/startnext ", "/workoutstatus ", "/workouthistory ", "/activity "},
		},
		{
			name:              "BP and Weight off omits combined section header",
			flags:             featureFlags{Medication: true, Workout: true, Food: true},
			wantHeaderAbsent:  []string{"**Blood Pressure & Weight:**"},
			wantCommandAbsent: []string{"/bp ", "/bphistory ", "/bpstats ", "/bpgoal ", "/weight ", "/weighthistory ", "/goal "},
		},
		{
			name:              "food off omits food section and commands",
			flags:             featureFlags{Medication: true, BP: true, Weight: true, Workout: true},
			wantHeaderAbsent:  []string{"**Food Commands:**"},
			wantCommandAbsent: []string{"/intake ", "/food "},
		},
		{
			name:              "medication off omits medication section and commands",
			flags:             featureFlags{BP: true, Weight: true, Workout: true, Food: true},
			wantHeaderAbsent:  []string{"**Medication Commands:**"},
			wantCommandAbsent: []string{"/log ", "/next ", "/stock ", "/download "},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text := b.buildHelpText(tc.flags)
			for _, h := range tc.wantHeaderAbsent {
				if strings.Contains(text, h) {
					t.Errorf("expected header %q absent, got: %s", h, text)
				}
			}
			for _, c := range tc.wantCommandAbsent {
				if strings.Contains(text, c) {
					t.Errorf("expected command line %q absent, got: %s", c, text)
				}
			}
		})
	}
}

// drainSetMyCommands consumes requestChan until a setMyCommands entry is
// observed (or the timeout fires) and returns the JSON-decoded command list
// from the request body. Other intercepted requests are skipped.
func drainSetMyCommands(t *testing.T, ch <-chan string, timeout time.Duration) []tgbotapi.BotCommand {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case entry := <-ch:
			parts := strings.SplitN(entry, "|", 2)
			if len(parts) != 2 {
				continue
			}
			path, body := parts[0], parts[1]
			if !strings.Contains(path, "setMyCommands") {
				continue
			}
			// requestChan stores a URL-unescaped form body. Parsing as
			// query values restores `commands=<json>` so the JSON payload
			// can be decoded without manual splitting.
			vals, err := url.ParseQuery(body)
			if err != nil {
				t.Fatalf("failed to parse setMyCommands body %q: %v", body, err)
			}
			raw := vals.Get("commands")
			if raw == "" {
				t.Fatalf("setMyCommands body missing commands key: %s", body)
			}
			var cmds []tgbotapi.BotCommand
			if err := json.Unmarshal([]byte(raw), &cmds); err != nil {
				t.Fatalf("failed to decode commands JSON %q: %v", raw, err)
			}
			return cmds
		case <-deadline:
			t.Fatalf("timed out waiting for setMyCommands request")
			return nil
		}
	}
}

func TestBot_RegisterCommands_PostsEnabledCommands(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	// Food intake defaults to disabled in the settings table; enable it so
	// the all-flags-on assertion covers every routed command.
	if err := env.s.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable food intake: %v", err)
	}
	if err := env.b.registerCommands(context.Background()); err != nil {
		t.Fatalf("registerCommands with all flags on: %v", err)
	}

	cmds := drainSetMyCommands(t, env.requestChan, time.Second)
	got := map[string]string{}
	for _, c := range cmds {
		got[c.Command] = c.Description
	}
	// All-flags-on body must contain every spec entry (every routed command,
	// since defaults in the settings repo are all enabled).
	for _, sp := range commandSpecs {
		desc, ok := got[sp.Name]
		if !ok {
			t.Errorf("expected setMyCommands body to include %q, got keys: %v", sp.Name, sortedKeys(boolMap(got)))
		}
		if desc != sp.Description {
			t.Errorf("setMyCommands description for %q = %q, want %q", sp.Name, desc, sp.Description)
		}
	}

	// Toggle BP off via the underlying settings repo and re-register. The
	// new body must omit BP commands but keep weight commands so the test
	// proves the filter is per-flag rather than all-or-nothing.
	if err := env.s.Settings.SetBloodPressureEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable BP: %v", err)
	}
	if err := env.b.registerCommands(context.Background()); err != nil {
		t.Fatalf("registerCommands with BP off: %v", err)
	}
	cmds = drainSetMyCommands(t, env.requestChan, time.Second)
	got = map[string]string{}
	for _, c := range cmds {
		got[c.Command] = c.Description
	}
	for _, name := range []string{"bp", "bphistory", "bpstats", "bpgoal"} {
		if _, ok := got[name]; ok {
			t.Errorf("expected %q absent from setMyCommands body with BP disabled", name)
		}
	}
	for _, name := range []string{"weight", "weighthistory", "goal", "start", "help"} {
		if _, ok := got[name]; !ok {
			t.Errorf("expected %q present in setMyCommands body with BP disabled", name)
		}
	}
}

func boolMap(m map[string]string) map[string]bool {
	out := make(map[string]bool, len(m))
	for k := range m {
		out[k] = true
	}
	return out
}

func TestBot_RegisterCommands_FailureDoesNotBlockPolling(t *testing.T) {
	env := setupBotTestCustom(t, func(path, body string) string {
		if strings.Contains(path, "setMyCommands") {
			// Mirror Telegram's not-ok shape so MakeRequest returns an
			// error to registerCommands. Start() must swallow that error
			// and continue to message routing.
			return `{"ok":false, "error_code":500, "description":"internal server error"}`
		}
		return `{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`
	})
	defer env.teardown()

	err := env.b.registerCommands(context.Background())
	if err == nil {
		t.Fatalf("expected registerCommands to surface the setMyCommands failure")
	}

	// Drain the failed setMyCommands request from the channel so subsequent
	// message-routing assertions don't see it.
	select {
	case <-env.requestChan:
	case <-time.After(time.Second):
		t.Fatalf("expected captured setMyCommands request")
	}

	// /help must still route normally — the failure path in registerCommands
	// is logged and swallowed (see Start), so the bot keeps serving commands.
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/help",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	env.b.handleMessage(msg)
	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Medication Tracker Bot") {
			t.Errorf("expected /help response after setMyCommands failure, got: %s", body)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for /help response after setMyCommands failure")
	}
}

func TestHandleBPCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/bp 120 80 70",
		From: &tgbotapi.User{ID: 123456},
		Date: 1771232400, // 2026-02-17 09:00:00 UTC
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 3},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "120/80") || !strings.Contains(body, "pulse 70") {
			t.Errorf("Unexpected BP response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for BP response")
	}

	// Verify it's in the store
	readings, err := env.s.BP.ListReadings(context.Background(), 123456, time.Time{})
	if err != nil {
		t.Fatalf("Error getting BP readings: %v", err)
	}
	if len(readings) != 1 {
		t.Errorf("Expected 1 BP reading, got %d", len(readings))
	} else {
		expectedTime := time.Unix(1771232400, 0)
		if !readings[0].MeasuredAt.Equal(expectedTime) {
			t.Errorf("Expected MeasuredAt %v, got %v", expectedTime, readings[0].MeasuredAt)
		}
	}
}

func TestHandleWeightCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/weight 75.5",
		From: &tgbotapi.User{ID: 123456},
		Date: 1771232460, // 2026-02-17 09:01:00 UTC
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 7},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "75.5") {
			t.Errorf("Unexpected weight response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for weight response")
	}
	// Verify it's in the store
	logs, err := env.s.Weight.ListLogs(context.Background(), 123456, time.Time{})
	if err != nil {
		t.Fatalf("Error getting weight logs: %v", err)
	}
	if len(logs) != 1 {
		t.Errorf("Expected 1 weight log, got %d", len(logs))
	} else {
		expectedTime := time.Unix(1771232460, 0)
		if !logs[0].MeasuredAt.Equal(expectedTime) {
			t.Errorf("Expected MeasuredAt %v, got %v", expectedTime, logs[0].MeasuredAt)
		}
	}
}

func TestHandleStockCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	// Add a medication with low stock
	medID, _ := env.s.Medication.Create("Test Med", "10mg", "{\"type\":\"daily\",\"times\":[\"09:00\"]}", nil, nil, "", "", "")
	count := 5
	env.s.Medication.SetInventory(medID, &count)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/stock",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 6},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Test Med") || !strings.Contains(body, "5") {
			t.Errorf("Unexpected stock response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for stock response")
	}
}

func TestBot_WatchSettingsChanges_ReregistersOnFlagToggle(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Sample the cursor *before* spawning the watcher goroutine so the
	// subsequent flag toggle is guaranteed to land after the cursor — the
	// production wiring achieves this same ordering by calling
	// GetLatestChangeCursor synchronously inside watchSettingsChanges before
	// the ticker starts. We bypass that wrapper here to avoid the goroutine
	// scheduling race with the toggle below.
	startCursor, err := env.s.Settings.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("read start cursor: %v", err)
	}
	go env.b.pollSettingsChanges(ctx, 20*time.Millisecond, startCursor)

	if err := env.s.Settings.SetBloodPressureEnabled(ctx, false); err != nil {
		t.Fatalf("disable BP: %v", err)
	}

	cmds := drainSetMyCommands(t, env.requestChan, time.Second)
	got := map[string]string{}
	for _, c := range cmds {
		got[c.Command] = c.Description
	}
	for _, name := range []string{"bp", "bphistory", "bpstats", "bpgoal"} {
		if _, ok := got[name]; ok {
			t.Errorf("expected %q absent from setMyCommands body after BP toggle off, got: %v", name, sortedKeys(boolMap(got)))
		}
	}
	for _, name := range []string{"weight", "weighthistory", "goal", "start", "help"} {
		if _, ok := got[name]; !ok {
			t.Errorf("expected %q present in setMyCommands body after BP toggle off, got: %v", name, sortedKeys(boolMap(got)))
		}
	}
}

func TestBot_WatchSettingsChanges_ExitsOnContextCancel(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx, cancel := context.WithCancel(context.Background())

	startCursor, err := env.s.Settings.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("read start cursor: %v", err)
	}

	done := make(chan struct{})
	go func() {
		env.b.pollSettingsChanges(ctx, 20*time.Millisecond, startCursor)
		close(done)
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pollSettingsChanges did not exit after context cancel")
	}

	// After cancel + exit, a subsequent flag toggle MUST NOT produce a
	// setMyCommands POST. Toggle and then assert the request channel stays
	// quiet for a generous multiple of the poll interval.
	if err := env.s.Settings.SetBloodPressureEnabled(context.Background(), false); err != nil {
		t.Fatalf("toggle after cancel: %v", err)
	}

	deadline := time.After(150 * time.Millisecond)
	for {
		select {
		case entry := <-env.requestChan:
			if strings.Contains(entry, "setMyCommands") {
				t.Fatalf("unexpected setMyCommands POST after context cancel: %s", entry)
			}
		case <-deadline:
			return
		}
	}
}

func TestHandleLogCommandWithDosage(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	env.s.Medication.Create("Allopurinol AL", "100mg", "{\"type\":\"daily\",\"times\":[\"09:00\"]}", nil, nil, "", "", "")
	env.s.Medication.Create("Bisoprolol", "", "{\"type\":\"daily\",\"times\":[\"09:00\"]}", nil, nil, "", "", "")

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/log",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 4},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Take Allopurinol AL (100mg)") {
			t.Errorf("Expected dosage in button for Allopurinol AL, got payload: %s", body)
		}
		if !strings.Contains(body, "\"text\":\"Take Bisoprolol\"") {
			t.Errorf("Expected exactly \"Take Bisoprolol\" formatting for Bisoprolol without dosage, got payload: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for /log response")
	}
}
