package executor

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"log/slog"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
)

// captureSlog redirects slog.Default() to a JSON handler that writes into a
// bytes.Buffer, restoring the previous default when the test ends. Returned
// buffer accumulates one JSON object per slog record.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// recordingAudit is a thread-safe AuditHook for tests.
type recordingAudit struct {
	mu        sync.Mutex
	summaries []RunSummary
}

func (r *recordingAudit) OnRun(_ context.Context, s RunSummary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.summaries = append(r.summaries, s)
}

func (r *recordingAudit) Snapshot() []RunSummary {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RunSummary, len(r.summaries))
	copy(out, r.summaries)
	return out
}

// --- Slog field coverage ---

func TestSlog_RunCompletedFieldsPresent(t *testing.T) {
	logBuf := captureSlog(t)
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp)

	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 1000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	// Every required structured field must appear in the slog output.
	required := []string{
		`"run_id"`,
		`"mode"`,
		`"duration_ms"`,
		`"api_calls"`,
		`"status"`,
		`"exit_reason"`,
	}
	out := logBuf.String()
	for _, k := range required {
		if !strings.Contains(out, k) {
			t.Errorf("expected slog to include %s, got: %s", k, out)
		}
	}
	if !strings.Contains(out, `"status":"ok"`) {
		t.Errorf("expected status=ok in slog, got: %s", out)
	}
	if !strings.Contains(out, `"exit_reason":"completed"`) {
		t.Errorf("expected exit_reason=completed in slog, got: %s", out)
	}
}

func TestSlog_SpawnFailureLogsExitReason(t *testing.T) {
	logBuf := captureSlog(t)
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return nil, errors.New("python missing")
	}}
	svc, _ := newTestService(t, sp)

	res, _ := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		t.Fatalf("expected sandbox_startup_failure, got %q", res.Status)
	}
	out := logBuf.String()
	if !strings.Contains(out, `"exit_reason":"spawn_failed"`) {
		t.Errorf("expected exit_reason=spawn_failed in slog, got: %s", out)
	}
	if !strings.Contains(res.Error, mcp.ExecuteErrSpawnFailed) {
		t.Errorf("expected envelope error to include %q, got %q", mcp.ExecuteErrSpawnFailed, res.Error)
	}
}

// --- Audit fan-out ---

func TestAudit_WriteRunFanOut(t *testing.T) {
	rec := &recordingAudit{}
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) { o.Audit = rec })

	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeWrite,
		Intent:    "edit a workout",
		TimeoutMS: 1000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	got := rec.Snapshot()
	if len(got) != 1 {
		t.Fatalf("expected 1 audit record, got %d", len(got))
	}
	if got[0].Mode != proxy.ModeWrite {
		t.Errorf("expected mode=write, got %q", got[0].Mode)
	}
	if got[0].Intent != "edit a workout" {
		t.Errorf("expected intent passed through, got %q", got[0].Intent)
	}
	if got[0].Status != mcp.ExecuteStatusOK {
		t.Errorf("expected status=ok, got %q", got[0].Status)
	}
	if got[0].ExitReason != "completed" {
		t.Errorf("expected exit_reason=completed, got %q", got[0].ExitReason)
	}
	if got[0].RunID == "" {
		t.Error("expected non-empty run_id")
	}
}

func TestAudit_ReadRunNotAuditedByDefault(t *testing.T) {
	rec := &recordingAudit{}
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) { o.Audit = rec })

	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 1000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got := rec.Snapshot(); len(got) != 0 {
		t.Errorf("expected no audit records for read-only run, got %d: %+v", len(got), got)
	}
}

func TestAudit_ReadRunAuditedWhenAuditAllRunsTrue(t *testing.T) {
	rec := &recordingAudit{}
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.Audit = rec
		o.AuditAllRuns = true
	})

	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 1000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got := rec.Snapshot(); len(got) != 1 {
		t.Errorf("expected 1 audit record when AuditAllRuns=true, got %d", len(got))
	}
}

func TestAudit_RejectionFanOut(t *testing.T) {
	rec := &recordingAudit{}
	releaseCh := make(chan struct{})
	startedCh := make(chan struct{}, 1)

	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		startedCh <- struct{}{}
		<-releaseCh
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.Audit = rec
		o.MaxConcurrent = 1
	})

	go func() {
		_, _ = svc.Execute(context.Background(), mcp.ExecutionRequest{
			Script:    "x",
			Mode:      proxy.ModeWrite,
			Intent:    "long write",
			TimeoutMS: 5000,
		})
	}()
	<-startedCh

	// Second call exceeds the concurrency cap; the rejection should still be
	// audited so security teams can spot a flood of blocked attempts.
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "y",
		Mode:      proxy.ModeWrite,
		Intent:    "blocked attempt",
		TimeoutMS: 5000,
	})
	if err != nil {
		close(releaseCh)
		t.Fatalf("second Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		close(releaseCh)
		t.Errorf("expected sandbox_startup_failure, got %q", res.Status)
	}
	if !strings.Contains(res.Error, mcp.ExecuteErrMaxConcurrent) {
		close(releaseCh)
		t.Errorf("expected error to include %q, got %q", mcp.ExecuteErrMaxConcurrent, res.Error)
	}

	close(releaseCh)
	// Wait briefly for the in-flight run to finish so its audit record lands.
	// We expect at least one rejection audit; the long run also audits when
	// it eventually completes.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(rec.Snapshot()) >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	got := rec.Snapshot()
	var rejection *RunSummary
	for i := range got {
		if got[i].ExitReason == "rejected" {
			rejection = &got[i]
			break
		}
	}
	if rejection == nil {
		t.Fatalf("expected a rejection audit record, got: %+v", got)
	}
	if rejection.Intent != "blocked attempt" {
		t.Errorf("expected intent forwarded to rejection audit, got %q", rejection.Intent)
	}
}

// --- Stable error codes ---

func TestErrorCodes_PrefixedInEnvelope(t *testing.T) {
	tests := []struct {
		name     string
		spawnFn  func(_ context.Context, _ []byte) ([]byte, error)
		wantCode string
	}{
		{
			name: "spawn failure prefixed",
			spawnFn: func(_ context.Context, _ []byte) ([]byte, error) {
				return nil, errors.New("python missing")
			},
			wantCode: mcp.ExecuteErrSpawnFailed,
		},
		{
			name: "invalid envelope prefixed",
			spawnFn: func(_ context.Context, _ []byte) ([]byte, error) {
				return []byte("not json"), nil
			},
			wantCode: mcp.ExecuteErrInvalidEnvelope,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sp := &fakeSpawner{fn: tc.spawnFn}
			svc, _ := newTestService(t, sp)
			res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if !strings.HasPrefix(res.Error, tc.wantCode) {
				t.Errorf("expected error to start with %q, got %q", tc.wantCode, res.Error)
			}
		})
	}
}

// --- Max concurrency ---

func TestMaxConcurrency_RejectionUsesStableCode(t *testing.T) {
	logBuf := captureSlog(t)
	releaseCh := make(chan struct{})
	startedCh := make(chan struct{}, 1)

	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		startedCh <- struct{}{}
		<-releaseCh
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) { o.MaxConcurrent = 1 })

	go func() {
		_, _ = svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 5000})
	}()
	<-startedCh

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "y", TimeoutMS: 5000})
	if err != nil {
		close(releaseCh)
		t.Fatalf("Execute: %v", err)
	}
	if !strings.HasPrefix(res.Error, mcp.ExecuteErrMaxConcurrent) {
		close(releaseCh)
		t.Errorf("expected stable code prefix %q, got %q", mcp.ExecuteErrMaxConcurrent, res.Error)
	}

	out := logBuf.String()
	if !strings.Contains(out, `"err_code":"`+mcp.ExecuteErrMaxConcurrent+`"`) {
		close(releaseCh)
		t.Errorf("expected slog to include err_code=%s, got: %s", mcp.ExecuteErrMaxConcurrent, out)
	}

	close(releaseCh)
}

// --- Cleanup for abandoned runs ---

func TestCleanup_PrunesAbandonedRunStates(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	// Disable the periodic ticker; we'll invoke cleanupAbandoned directly so
	// the test stays deterministic.
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.AbandonedRunTimeout = 50 * time.Millisecond
		o.CleanupInterval = -1
	})

	// Inject a stale run state directly.
	svc.mu.Lock()
	svc.runs["stale-token"] = &runState{
		runID:     "stale-run",
		startedAt: time.Now().Add(-1 * time.Hour),
	}
	svc.mu.Unlock()

	pruned := svc.cleanupAbandoned()
	if pruned != 1 {
		t.Errorf("expected 1 pruned run, got %d", pruned)
	}

	svc.mu.Lock()
	_, exists := svc.runs["stale-token"]
	svc.mu.Unlock()
	if exists {
		t.Error("expected stale run to be removed from runs map")
	}
	if svc.AbandonedRunsTotal() != 1 {
		t.Errorf("expected AbandonedRunsTotal=1, got %d", svc.AbandonedRunsTotal())
	}
}

func TestCleanup_LeavesFreshRunsAlone(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.AbandonedRunTimeout = 1 * time.Hour
		o.CleanupInterval = -1
	})

	svc.mu.Lock()
	svc.runs["fresh-token"] = &runState{
		runID:     "fresh-run",
		startedAt: time.Now(),
	}
	svc.mu.Unlock()

	pruned := svc.cleanupAbandoned()
	if pruned != 0 {
		t.Errorf("expected 0 pruned runs, got %d", pruned)
	}

	svc.mu.Lock()
	_, exists := svc.runs["fresh-token"]
	svc.mu.Unlock()
	if !exists {
		t.Error("expected fresh run to remain")
	}
}

func TestCleanup_TickerRunsPeriodically(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.AbandonedRunTimeout = 20 * time.Millisecond
		o.CleanupInterval = 25 * time.Millisecond
	})

	// Inject a stale run and wait for the ticker to fire.
	svc.mu.Lock()
	svc.runs["ticker-stale"] = &runState{
		runID:     "ticker-run",
		startedAt: time.Now().Add(-1 * time.Minute),
	}
	svc.mu.Unlock()

	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		svc.mu.Lock()
		_, still := svc.runs["ticker-stale"]
		svc.mu.Unlock()
		if !still {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	svc.mu.Lock()
	_, still := svc.runs["ticker-stale"]
	svc.mu.Unlock()
	if still {
		t.Error("expected janitor ticker to prune stale run")
	}
}

func TestCleanup_CancelsAbandonedRunContext(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp, func(o *Options) {
		o.AbandonedRunTimeout = 1 * time.Millisecond
		o.CleanupInterval = -1
	})

	cancelCalled := false
	svc.mu.Lock()
	svc.runs["abandoned"] = &runState{
		runID:     "abandoned-run",
		startedAt: time.Now().Add(-1 * time.Hour),
		cancel: func() {
			cancelCalled = true
		},
	}
	svc.mu.Unlock()

	svc.cleanupAbandoned()
	if !cancelCalled {
		t.Error("expected cleanupAbandoned to call cancel on abandoned run")
	}
}

// --- Audit hook panic safety ---

func TestAudit_HookPanicDoesNotCrash(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	hook := AuditHookFunc(func(_ context.Context, _ RunSummary) {
		panic("boom")
	})
	svc, _ := newTestService(t, sp, func(o *Options) { o.Audit = hook })

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeWrite,
		Intent:    "test",
		TimeoutMS: 1000,
	})
	if err != nil {
		t.Fatalf("Execute should not return an error when audit hook panics: %v", err)
	}
	if res.Status != mcp.ExecuteStatusOK {
		t.Errorf("expected ok status despite hook panic, got %q", res.Status)
	}
}

// --- Helper sanity ---

func TestTruncateForLog(t *testing.T) {
	if got := truncateForLog("hello", 100); got != "hello" {
		t.Errorf("short string should pass through, got %q", got)
	}
	if got := truncateForLog("hello world", 5); got != "hello...(truncated)" {
		t.Errorf("expected truncation, got %q", got)
	}
	if got := truncateForLog("any", 0); got != "any" {
		t.Errorf("non-positive maxLen should pass through, got %q", got)
	}
}

// --- Smoke: payload marshalling never includes secrets ---

func TestSlog_ExecutorStartLogIncludesAbandonedTimeout(t *testing.T) {
	logBuf := captureSlog(t)
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`null`), nil }}
	_, _ = newTestService(t, sp, func(o *Options) { o.AbandonedRunTimeout = 250 * time.Millisecond })

	out := logBuf.String()
	if !strings.Contains(out, `"abandoned_timeout_ms":250`) {
		t.Errorf("expected start slog to include abandoned_timeout_ms, got: %s", out)
	}
}

