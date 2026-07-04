package gamification

// rescore_imports_test.go guards EnsureFreshWeek's day range: it must re-score
// the whole prior ISO week (closed_last_week's ledger range) plus the reviewed
// week up to (but never past) the real current day, so a lever close on an
// earlier day of either week is folded into the weekly review — while a mid-week
// read never scores a future day (which would write a premature weekly gauge
// award on an incomplete week).

import (
	"context"
	"testing"
	"time"
)

// recordingSvc wraps a real service and records the days ScoreDay is called with.
type recordingSvc struct {
	GamificationService
	days []time.Time
}

func (r *recordingSvc) ScoreDay(ctx context.Context, userID int64, day time.Time) error {
	r.days = append(r.days, day)
	return r.GamificationService.ScoreDay(ctx, userID, day)
}

func TestEnsureFreshWeek_ScoresElapsedWeekOnly(t *testing.T) {
	// 2026-06-21 is a Sunday; its ISO week is Mon 06-15 .. Sun 06-21.
	sun := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)
	if !isWeekEndDay(sun) {
		t.Fatalf("fixture bug: %v is not a week-end day", sun)
	}
	// The reviewed week is Mon 06-15..Sun 06-21; its prior week (closed_last_week)
	// is Mon 06-08..Sun 06-14, so the freshness range always starts at priorMon.
	priorMon := time.Date(2026, 6, 8, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name          string
		reviewAnchor  time.Time
		now           time.Time
		wantFirst     time.Time
		wantLast      time.Time
		wantDaysCount int
	}{
		{
			// Mid-week read: score prior week Mon..Sun (7) + this week Mon..Wed (3),
			// never the future Thu-Sun.
			name:          "mid-week read stops at today",
			reviewAnchor:  time.Date(2026, 6, 17, 12, 0, 0, 0, time.UTC),
			now:           time.Date(2026, 6, 17, 12, 0, 0, 0, time.UTC),
			wantFirst:     priorMon,
			wantLast:      time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC),
			wantDaysCount: 10,
		},
		{
			// Sunday read: prior week + whole reviewed week Mon..Sun.
			name:          "week-end read covers the full week",
			reviewAnchor:  sun,
			now:           sun,
			wantFirst:     priorMon,
			wantLast:      sun,
			wantDaysCount: 14,
		},
		{
			// West-of-UTC digest: anchored a day back (Sunday) while the real
			// clock has rolled into Monday of the next week. Must still cover the
			// prior week + reviewed week Mon..Sun and clamp at the reviewed Sunday
			// end, not the new Monday.
			name:          "digest anchor a day back, clock rolled into next week",
			reviewAnchor:  sun,
			now:           time.Date(2026, 6, 22, 1, 0, 0, 0, time.UTC),
			wantFirst:     priorMon,
			wantLast:      sun,
			wantDaysCount: 14,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}})
			rec := &recordingSvc{GamificationService: svc}
			EnsureFreshWeek(context.Background(), rec, 1, tc.reviewAnchor, tc.now)

			if len(rec.days) != tc.wantDaysCount {
				t.Fatalf("scored %d days, want %d: %v", len(rec.days), tc.wantDaysCount, rec.days)
			}
			if !rec.days[0].Equal(tc.wantFirst) {
				t.Errorf("first scored day = %v, want %v", rec.days[0], tc.wantFirst)
			}
			last := rec.days[len(rec.days)-1]
			if !last.Equal(tc.wantLast) {
				t.Errorf("last scored day = %v, want %v", last, tc.wantLast)
			}
			// Oldest-first and contiguous (the streak fold requires calendar order).
			for i := 1; i < len(rec.days); i++ {
				if !rec.days[i].Equal(rec.days[i-1].AddDate(0, 0, 1)) {
					t.Errorf("days not contiguous oldest-first at %d: %v then %v", i, rec.days[i-1], rec.days[i])
				}
			}
		})
	}
}
