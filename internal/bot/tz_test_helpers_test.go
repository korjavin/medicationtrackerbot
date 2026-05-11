package bot

import (
	"context"
	"sync"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
)

// Compile-time assertion: the test double must satisfy tzupdate.Service so
// the bot can be wired with it through the same field that production uses.
var _ tzupdate.Service = (*mockTZUpdater)(nil)

// mockTZUpdater is a shared test double for tzupdate.Service used across bot
// tests. It records every UpdateTimezone call and returns configurable
// (planCreated, err) values so tests can drive both branches of the bot's
// confirmation-message logic.
type mockTZUpdater struct {
	mu          sync.Mutex
	calls       []string
	planCreated bool
	err         error
}

func (m *mockTZUpdater) UpdateTimezone(_ context.Context, newTZ string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, newTZ)
	return m.planCreated, m.err
}

func (m *mockTZUpdater) recordedCalls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.calls))
	copy(out, m.calls)
	return out
}
