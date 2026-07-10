package cloudstore

import (
	"context"
	"testing"
	"time"
)

// bd med-d5t.5 — the per-minute limiter bounds burst rate; it does not bound
// SPEND on the operator's own provider key. These counters are the spend cap,
// and they live in the database precisely so a redeploy cannot hand everyone a
// fresh budget.
func TestConsumeTrialRequest(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)

	t.Run("allows up to the per-account cap, then refuses naming the account scope", func(t *testing.T) {
		r := setupRepo(t)
		for i := range 3 {
			allowed, scope, err := r.ConsumeTrialRequest(ctx, "acct-1", now, 3, 0)
			if err != nil || !allowed {
				t.Fatalf("call %d: allowed=%v scope=%q err=%v", i+1, allowed, scope, err)
			}
		}
		allowed, scope, err := r.ConsumeTrialRequest(ctx, "acct-1", now, 3, 0)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if allowed {
			t.Error("4th call allowed past a cap of 3")
		}
		if scope != TrialScopeAccount {
			t.Errorf("scope = %q, want %q", scope, TrialScopeAccount)
		}
	})

	t.Run("one account cannot exhaust another's share", func(t *testing.T) {
		r := setupRepo(t)
		for range 3 {
			if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 3, 0); !allowed {
				t.Fatal("acct-1 refused inside its own cap")
			}
		}
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-2", now, 3, 0); !allowed {
			t.Error("acct-2 refused because acct-1 spent its own budget")
		}
	})

	// The point of the global cap: a bug or a bad actor must not run the bill up
	// while the operator sleeps, however many accounts they spread it across.
	t.Run("the global cap binds across accounts", func(t *testing.T) {
		r := setupRepo(t)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 0, 2); !allowed {
			t.Fatal("first call refused")
		}
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-2", now, 0, 2); !allowed {
			t.Fatal("second call refused")
		}
		allowed, scope, err := r.ConsumeTrialRequest(ctx, "acct-3", now, 0, 2)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if allowed {
			t.Error("third account allowed past a global cap of 2")
		}
		if scope != TrialScopeGlobal {
			t.Errorf("scope = %q, want %q", scope, TrialScopeGlobal)
		}
	})

	t.Run("reports the account scope first — it is the more actionable one", func(t *testing.T) {
		r := setupRepo(t)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 1); !allowed {
			t.Fatal("first call refused")
		}
		_, scope, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 1)
		if scope != TrialScopeAccount {
			t.Errorf("scope = %q, want %q when both caps are hit", scope, TrialScopeAccount)
		}
	})

	t.Run("a refused call does not consume budget", func(t *testing.T) {
		r := setupRepo(t)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 0); !allowed {
			t.Fatal("first call refused")
		}
		for range 5 {
			if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 0); allowed {
				t.Fatal("refused call was allowed")
			}
		}
		// Tomorrow's budget must be untouched by today's refusals.
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now.Add(24*time.Hour), 1, 0); !allowed {
			t.Error("the next day's first call was refused — refusals leaked into the counter")
		}
	})

	t.Run("budgets are per UTC day", func(t *testing.T) {
		r := setupRepo(t)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 1); !allowed {
			t.Fatal("first call refused")
		}
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 1); allowed {
			t.Fatal("cap not enforced")
		}
		tomorrow := time.Date(2026, 7, 11, 0, 0, 1, 0, time.UTC)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", tomorrow, 1, 1); !allowed {
			t.Error("the cap did not reset at UTC midnight")
		}
	})

	t.Run("a limit of zero disables that scope", func(t *testing.T) {
		r := setupRepo(t)
		for i := range 50 {
			if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 0, 0); !allowed {
				t.Fatalf("call %d refused with both caps disabled", i+1)
			}
		}
	})

	// Restart survival is the whole reason these counters are in SQLite: an
	// in-memory budget would make a crash-loop a way to bill the operator
	// without limit. A fresh Repo over the same handle is what a redeploy sees.
	t.Run("counters survive a new Repo over the same database", func(t *testing.T) {
		r := setupRepo(t)
		if allowed, _, _ := r.ConsumeTrialRequest(ctx, "acct-1", now, 1, 0); !allowed {
			t.Fatal("first call refused")
		}
		reopened, err := New(r.db)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if allowed, scope, _ := reopened.ConsumeTrialRequest(ctx, "acct-1", now, 1, 0); allowed {
			t.Errorf("budget reset across restart (scope=%q)", scope)
		}
	})
}
