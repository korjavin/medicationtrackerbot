package seeddemo

import (
	"context"
	"fmt"
	"math/rand/v2"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// diaryEntry pairs a content snippet with an optional tag. nil tag means an
// untagged note in the UI; the demo mixes a few of these in to mirror real
// usage where users sometimes leave the tag blank.
type diaryEntry struct {
	content string
	tag     *string
}

func diaryTag(s string) *string { return &s }

// demoDiaryEntries is the fixed catalogue of 12 notes spread across the
// window. Tags cover energy / mood / symptom / blank to exercise every
// filter chip on the diary UI.
var demoDiaryEntries = []diaryEntry{
	{content: "Felt sluggish this morning, took a long walk after lunch and energy picked up.", tag: diaryTag("energy")},
	{content: "Headache flared around 3pm, settled after water and a snack.", tag: diaryTag("symptom")},
	{content: "Slept poorly — kept waking up. Mood was flat all day.", tag: diaryTag("mood")},
	{content: "Calf cramps overnight. Going to add electrolytes tomorrow.", tag: diaryTag("symptom")},
	{content: "Crushed the morning workout, felt strong on the bench press.", tag: diaryTag("energy")},
	{content: "Anxious before the meeting; box-breathing helped.", tag: diaryTag("mood")},
	{content: "Random observation: weight is trending down even though appetite is up.", tag: nil},
	{content: "Mild dizziness when standing fast. Will mention next BP check.", tag: diaryTag("symptom")},
	{content: "Genuinely good mood today — first sunny weekend in a while.", tag: diaryTag("mood")},
	{content: "Energy rebounded after switching coffee to before breakfast instead of after.", tag: diaryTag("energy")},
	{content: "Tried the new HIIT routine. Knees a little sore, nothing sharp.", tag: nil},
	{content: "Stomach felt off after dinner — likely the spicy sauce.", tag: diaryTag("symptom")},
}

// tzHistoryEntry is one timezone change with the day-before-anchor it took
// effect. The seeder writes them in chronological order so the rolled-up
// "current TZ" matches the most recent entry.
type tzHistoryEntry struct {
	timezone        string
	daysFromAnchor  int
}

// demoTZHistory mirrors the offset transitions hardcoded in vitals.go so
// sleep-log timezone_offset values line up with the active TZ at that point
// in the window.
var demoTZHistory = []tzHistoryEntry{
	{timezone: "America/New_York", daysFromAnchor: 90},
	{timezone: "Europe/Berlin", daysFromAnchor: 45},
	{timezone: "America/New_York", daysFromAnchor: 10},
}

// generateMisc seeds diary notes and timezone_history rows. Both go in via
// raw INSERTs because the public store methods stamp `created_at`/`recorded_at`
// from the wall clock and would refuse backdated timestamps.
func generateMisc(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	if err := generateDiary(ctx, s, opts, clk, rng, summary); err != nil {
		return fmt.Errorf("diary: %w", err)
	}
	if err := generateTimezoneHistory(ctx, s, opts, clk, summary); err != nil {
		return fmt.Errorf("timezone history: %w", err)
	}
	return nil
}

func generateDiary(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	count := len(demoDiaryEntries)
	if count == 0 {
		return nil
	}
	// Spread notes evenly across the window so the diary timeline isn't bunched.
	step := opts.Days / count
	if step <= 0 {
		step = 1
	}

	for i, entry := range demoDiaryEntries {
		off := i * step
		if off >= opts.Days {
			off = opts.Days - 1
		}
		hour := 7 + rng.IntN(15) // 07..21
		minute := rng.IntN(60)
		createdAt := clk.at(off, hour, minute)

		var tagArg interface{}
		if entry.tag != nil {
			tagArg = *entry.tag
		}
		if _, err := s.DB().ExecContext(ctx,
			`INSERT INTO diary_notes (user_id, content, tag, created_at) VALUES (?, ?, ?, ?)`,
			opts.UserID, entry.content, tagArg, createdAt,
		); err != nil {
			return fmt.Errorf("insert diary note %d: %w", i, err)
		}
		summary.DiaryNotes++
	}
	return nil
}

func generateTimezoneHistory(ctx context.Context, s *store.Store, _ Options, clk *clock, summary *Summary) error {
	for _, entry := range demoTZHistory {
		recordedAt := clk.daysFromAnchor(entry.daysFromAnchor)
		if _, err := s.DB().ExecContext(ctx,
			`INSERT INTO timezone_history (timezone, recorded_at) VALUES (?, ?)`,
			entry.timezone, recordedAt,
		); err != nil {
			return fmt.Errorf("insert tz history %s: %w", entry.timezone, err)
		}
		summary.TimezoneEvents++
	}
	return nil
}
