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
// tests. It records every UpdateTimezone call and returns a configurable
// (planCreated, err). A successful (err==nil) call always reports
// Changed=true — the bot doesn't branch on Changed, and modelling the
// short-circuit case would require state the bot tests don't exercise.
type mockTZUpdater struct {
	mu          sync.Mutex
	calls       []string
	planCreated bool
	err         error
}

func (m *mockTZUpdater) UpdateTimezone(_ context.Context, newTZ string) (tzupdate.UpdateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, newTZ)
	if m.err != nil {
		return tzupdate.UpdateResult{}, m.err
	}
	return tzupdate.UpdateResult{Changed: true, PlanCreated: m.planCreated}, nil
}

func (m *mockTZUpdater) recordedCalls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.calls))
	copy(out, m.calls)
	return out
}
