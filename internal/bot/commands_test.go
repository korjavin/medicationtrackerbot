package bot

import (
	"context"
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
