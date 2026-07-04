package server

// Gamification read endpoints (Plan 2, Task 2). Handlers stay thin: they call
// only the GamificationService (Critical Rule #1), which applies the feature gate
// itself and returns an {enabled:false}-shaped empty body when the flag is off —
// so there is no flag branching here. Auth (and the 401 for unauthenticated
// requests) is handled by the apiMux middleware before these run.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// ensureGamificationFresh delegates to gamificationsvc.EnsureFresh, the shared
// first-read backfill + yesterday/today rescore prelude used by every gamification
// read surface (HTTP, /week bot, Sunday digest). See EnsureFresh for the window
// rationale.
func (s *Server) ensureGamificationFresh(ctx context.Context, userID int64) {
	gamificationsvc.EnsureFresh(ctx, s.gamificationSvc, userID, time.Now())
}

// handleGamificationSummary serves the full read model: rings + level + HP +
// next-level progress + streak + insight tier.
func (s *Server) handleGamificationSummary(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	sum, err := s.gamificationSvc.GetSummary(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, sum)
}

// handleGamificationJourney serves the fuller Journey payload: the summary plus
// HP history, unlocked insight tiers, and the level curve.
func (s *Server) handleGamificationJourney(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	j, err := s.gamificationSvc.GetJourney(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, j)
}

// ringsView is the slim Today-widget payload: per-ring HP earned today plus the
// level badge. A projection of Summary, so the Today ring widget can render
// without pulling the full journey. HealthScore rides along (Task 8) so the
// Today tile's headline can show the 0-100 composite instead of raw today_hp
// without a second round-trip to the full Summary.
type ringsView struct {
	Enabled        bool                               `json:"enabled"`
	Level          int                                `json:"level"`
	TodayHP        int                                `json:"today_hp"`
	Rings          []gamstore.RingScore               `json:"rings"`
	HealthScore    gamificationsvc.HealthScoreView    `json:"health_score"`
	AdherenceAlert gamificationsvc.AdherenceAlertView `json:"adherence_alert"`
}

// handleGamificationRings serves the slim Today rings payload.
func (s *Server) handleGamificationRings(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	sum, err := s.gamificationSvc.GetSummary(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, ringsView{
		Enabled:        sum.Enabled,
		Level:          sum.Level,
		TodayHP:        sum.TodayHP,
		Rings:          sum.TodayRings,
		HealthScore:    sum.HealthScore,
		AdherenceAlert: sum.AdherenceAlert,
	})
}

// handleGamificationTargets serves the targets-editor read model: each
// overridable metric's effective band (recommended defaults overlaid with the
// user's overrides), its recommended default, and whether the user customized it.
func (s *Server) handleGamificationTargets(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	view, err := s.gamificationSvc.EffectiveTargets(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

// handleSetGamificationTargets validates and persists a batch of band-shaped
// target overrides, then returns the refreshed read model. An unknown metric key
// or an out-of-bounds / incoherent band is rejected with 400 — the service runs
// the same validation any surface would (Critical Rule #1). When the flag is off
// the upserts are no-ops and the response carries the {enabled:false} shape.
func (s *Server) handleSetGamificationTargets(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Targets []gamstore.Target `json:"targets"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	view, err := s.gamificationSvc.SetTargets(r.Context(), userID, req.Targets)
	if err != nil {
		if errors.Is(err, gamificationsvc.ErrUnknownTargetMetric) || errors.Is(err, gamificationsvc.ErrInvalidTarget) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

// handleGamificationInsights serves the tier-3 personal-insight read model
// (sleep→next-morning-BP). The service gates on the feature flag and the
// user's unlocked insight tier internally, so this handler is a verbatim
// pass-through (Critical Rule #1).
func (s *Server) handleGamificationInsights(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	view, err := s.gamificationSvc.GetInsights(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

// handleGamificationGauges serves the gauge-trend read model (weight
// velocity/acceleration, BP rolling share, resting-HR trend). The service
// gates on the feature flag internally, so this handler is a verbatim
// pass-through (Critical Rule #1).
func (s *Server) handleGamificationGauges(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	view, err := s.gamificationSvc.GetGauges(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

// handleGamificationWeeklyReview serves the weekly review read model (lever
// closed-day counts, gauge movement, best day, Health Score movement, all
// current week vs previous week). The service gates on the feature flag
// internally, so this handler is a verbatim pass-through (Critical Rule #1).
func (s *Server) handleGamificationWeeklyReview(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	s.ensureGamificationFresh(r.Context(), userID)

	view, err := s.gamificationSvc.GetWeeklyReview(r.Context(), userID, time.Now().UTC())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, view)
}

// writeJSON encodes v as the JSON response body, logging an encode failure.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "error", err)
	}
}
