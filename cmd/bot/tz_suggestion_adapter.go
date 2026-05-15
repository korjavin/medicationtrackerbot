package main

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// tzSuggestionSettings adapts *store.Repos to tzsuggestion.SettingsStore. The
// interface spans tz.Repo (current timezone reads) and settings.Repo
// (dismissed-suggestion read/write), so a small aggregator lives at the
// composition root.
type tzSuggestionSettings struct {
	s *store.Repos
}

func newTZSuggestionSettings(s *store.Repos) *tzSuggestionSettings {
	return &tzSuggestionSettings{s: s}
}

func (a *tzSuggestionSettings) GetCurrentTimezone() (string, error) {
	return a.s.TZ.GetCurrentTimezone()
}

func (a *tzSuggestionSettings) GetDismissedTZSuggestion(ctx context.Context) (string, error) {
	return a.s.Settings.GetDismissedTZSuggestion(ctx)
}

func (a *tzSuggestionSettings) SetDismissedTZSuggestion(ctx context.Context, tz string) error {
	return a.s.Settings.SetDismissedTZSuggestion(ctx, tz)
}
