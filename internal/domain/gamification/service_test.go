package gamification

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
)

// fakeSettings is the only narrow store the gate touches; the construction/gate
// test passes nil for the per-domain read stores since gate never calls them.
type fakeSettings struct {
	enabled bool
	err     error
}

func (f fakeSettings) GetGamificationEnabled(context.Context) (bool, error) {
	return f.enabled, f.err
}

// newTestService builds a service with only a settings fake wired; the remaining
// narrow stores are nil because Task 6 only exercises construction + the gate.
func newTestService(s SettingsStore) *service {
	return New(nil, nil, nil, nil, nil, nil, nil, nil, s, nil)
}

func TestNew_DefaultsConfigAndClock(t *testing.T) {
	svc := newTestService(fakeSettings{enabled: true})
	if svc == nil {
		t.Fatal("New returned nil")
	}
	// cfg defaults to scoring.DefaultConfig().
	if got, want := svc.cfg.FloorHP, scoring.DefaultConfig().FloorHP; got != want {
		t.Fatalf("default cfg.FloorHP = %d, want %d", got, want)
	}
	if got := svc.cfg.LevelBase; got != scoring.DefaultConfig().LevelBase {
		t.Fatalf("default cfg.LevelBase = %v, want %v", got, scoring.DefaultConfig().LevelBase)
	}
	// now defaults to a real clock (non-nil, returns a sane recent time).
	if svc.now == nil {
		t.Fatal("New left now clock nil")
	}
	if svc.now().IsZero() {
		t.Fatal("default clock returned zero time")
	}
}

func TestService_Gate(t *testing.T) {
	ctx := context.Background()
	boom := errors.New("settings boom")

	tests := []struct {
		name      string
		settings  fakeSettings
		wantOK    bool
		wantError error
	}{
		{name: "flag on", settings: fakeSettings{enabled: true}, wantOK: true},
		{name: "flag off", settings: fakeSettings{enabled: false}, wantOK: false},
		{name: "store error propagates", settings: fakeSettings{err: boom}, wantError: boom},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := newTestService(tc.settings)

			// gate (unexported) and Enabled (public) must agree.
			gotGate, gateErr := svc.gate(ctx)
			gotEnabled, enabledErr := svc.Enabled(ctx)

			if tc.wantError != nil {
				if !errors.Is(gateErr, tc.wantError) {
					t.Fatalf("gate err = %v, want %v", gateErr, tc.wantError)
				}
				if !errors.Is(enabledErr, tc.wantError) {
					t.Fatalf("Enabled err = %v, want %v", enabledErr, tc.wantError)
				}
				return
			}
			if gateErr != nil {
				t.Fatalf("gate unexpected err: %v", gateErr)
			}
			if enabledErr != nil {
				t.Fatalf("Enabled unexpected err: %v", enabledErr)
			}
			if gotGate != tc.wantOK || gotEnabled != tc.wantOK {
				t.Fatalf("gate=%v Enabled=%v, want %v", gotGate, gotEnabled, tc.wantOK)
			}
		})
	}
}

// compile-time guard: the test clock helper type-checks against time.Time so the
// fixed-clock injection pattern Tasks 7–10 rely on is exercised here too.
func TestService_ClockOverride(t *testing.T) {
	fixed := time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC)
	svc := newTestService(fakeSettings{enabled: true})
	svc.now = func() time.Time { return fixed }
	if !svc.now().Equal(fixed) {
		t.Fatalf("clock override not applied: got %v", svc.now())
	}
}
