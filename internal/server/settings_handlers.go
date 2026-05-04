package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/medplan"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) getFeatureMap(ctx context.Context) (map[string]bool, error) {
	foodEnabled, err := s.settings.GetFoodIntakeEnabled(ctx)
	if err != nil {
		return nil, err
	}
	bpEnabled, err := s.settings.GetBloodPressureEnabled(ctx)
	if err != nil {
		return nil, err
	}
	weightEnabled, err := s.settings.GetWeightEnabled(ctx)
	if err != nil {
		return nil, err
	}
	medicationEnabled, err := s.settings.GetMedicationEnabled(ctx)
	if err != nil {
		return nil, err
	}
	workoutEnabled, err := s.settings.GetWorkoutEnabled(ctx)
	if err != nil {
		return nil, err
	}
	healthEnabled, err := s.settings.GetHealthEnabled(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]bool{
		"food":       foodEnabled,
		"bp":         bpEnabled,
		"weight":     weightEnabled,
		"medication": medicationEnabled,
		"workout":    workoutEnabled,
		"health":     healthEnabled,
	}, nil
}

func (s *Server) handleGetFeatureSettings(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(features)
}

// handleInit returns all data needed to render the app on first load.
func (s *Server) handleInit(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"features": features,
	})
}

type weightGoalBootstrapResponse struct {
	Goal          *float64   `json:"goal,omitempty"`
	GoalDate      *time.Time `json:"goal_date,omitempty"`
	HighestWeight *float64   `json:"highest_weight,omitempty"`
	HighestDate   *time.Time `json:"highest_date,omitempty"`
}

// computeNextIntakeData returns the nearest scheduled intake in the next 12h window.
// IDs are returned alongside names so the frontend can resolve the upcoming cluster
// without name-based lookups (two meds with the same name and different dosages
// collapse to the first match when resolving by name alone).
//
// Implementation note: this delegates to medplan.PlanDoses so the forecast
// stays in lockstep with what the medication scheduler will actually fire.
// Any new exclusion rule (overlap with a consumed transition step, expired
// course, weekly-day gate, …) only needs to be expressed once, in medplan,
// and both surfaces inherit it.
func (s *Server) computeNextIntakeData(now time.Time) (time.Time, []int64, []string, error) {
	meds, err := s.meds.ListMedications(false)
	if err != nil {
		return time.Time{}, nil, nil, err
	}

	// Use the user's stored timezone so that schedule times are interpreted
	// correctly regardless of the server's local timezone.
	userLoc := now.Location()
	if tz, tzErr := s.settings.GetCurrentTimezone(); tzErr == nil && tz != "" {
		if loc, locErr := time.LoadLocation(tz); locErr == nil {
			userLoc = loc
		}
	}

	// Plan inputs for the planner: pending steps for any APPROVED plan,
	// plus the latest consumed step time per medication so the overlap
	// guard fires the same way the scheduler does after a westbound flight.
	var pendingSteps []store.TZTransitionStep
	consumedStepTimeByMed := make(map[int64]time.Time)
	if s.tzPlanStore != nil {
		if plan, err := s.tzPlanStore.GetLatestActiveOrPendingTZTransitionPlan(); err == nil && plan != nil {
			if plan.Status == "APPROVED" {
				if steps, err := s.tzPlanStore.GetPendingStepsForPlan(plan.ID); err == nil {
					pendingSteps = steps
				}
			}
			if m, err := s.tzPlanStore.GetLatestConsumedStepTimePerMed(plan.ID); err == nil {
				consumedStepTimeByMed = m
			}
		}
	}

	targets := medplan.PlanDoses(medplan.Inputs{
		Medications:           meds,
		PendingSteps:          pendingSteps,
		ConsumedStepTimeByMed: consumedStepTimeByMed,
		UserLoc:               userLoc,
		Now:                   now,
		Window:                12 * time.Hour,
	})

	medByID := make(map[int64]store.Medication, len(meds))
	for _, m := range meds {
		medByID[m.ID] = m
	}

	var nextTime time.Time
	var nextMeds []store.Medication

	// Doses landing within ±forecastClusterWindow of the chosen earliest
	// target are treated as a single cluster on the Today widget. Plan-step
	// times inherit sub-second drift from the user's actual taken_at (e.g.
	// 08:22:06 instead of 08:20:00) while normal-schedule times are
	// clock-aligned, so without a tolerance the four "morning meds" group
	// would split into two visually-arbitrary buckets two minutes apart.
	const forecastClusterWindow = 10 * time.Minute
	absDiff := func(a, b time.Time) time.Duration {
		d := a.Sub(b)
		if d < 0 {
			d = -d
		}
		return d
	}

	for _, t := range targets {
		// Skip targets the user already acted on (TAKEN / SKIPPED). The
		// planner does not look at intake_log because that is the caller's
		// responsibility; for forecast purposes we want to advertise the
		// next dose the user has not yet handled.
		intake, _ := s.meds.GetIntakeBySchedule(t.MedicationID, t.ScheduledAt)
		if intake != nil && (intake.Status == "TAKEN" || intake.Status == "SKIPPED") {
			continue
		}

		med, ok := medByID[t.MedicationID]
		if !ok {
			continue
		}

		switch {
		case nextTime.IsZero() || t.ScheduledAt.Before(nextTime):
			nextTime = t.ScheduledAt
			nextMeds = []store.Medication{med}
		case absDiff(t.ScheduledAt, nextTime) <= forecastClusterWindow:
			nextMeds = append(nextMeds, med)
		}
	}

	if len(nextMeds) == 0 {
		return time.Time{}, nil, nil, nil
	}

	ids := make([]int64, len(nextMeds))
	names := make([]string, len(nextMeds))
	for i, m := range nextMeds {
		ids[i] = m.ID
		names[i] = m.Name
	}

	return nextTime, ids, names, nil
}

// handleBootstrap returns a broad initial snapshot to minimize first-load request fanout.
func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	tgUser, ok := r.Context().Value(UserCtxKey).(*TelegramUser)
	if !ok || tgUser == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	ctx := context.Background()
	now := time.Now()
	userID := tgUser.ID
	bootstrapCursor := s.currentChangeCursor()

	features, err := s.getFeatureMap(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	medications, err := s.meds.ListMedications(true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	historyDefault, err := s.meds.GetIntakeHistory(0, 3)
	if err != nil {
		slog.Error("bootstrap history query failed", "error", err)
		historyDefault = []store.IntakeLog{}
	}

	var nextIntake any
	nextIntakeOK := true
	nextTime, nextIDs, nextNames, err := s.computeNextIntakeData(now)
	if err != nil {
		slog.Error("bootstrap next intake query failed", "error", err)
		nextIntakeOK = false
	} else if !nextTime.IsZero() {
		nextIntake = map[string]any{
			"scheduled_at":     nextTime.Format(time.RFC3339),
			"medication_ids":   nextIDs,
			"medication_names": nextNames,
		}
	}

	bpSince := now.AddDate(0, 0, -60)
	bpReadings, err := s.bp.GetBloodPressureReadings(ctx, userID, bpSince)
	if err != nil {
		slog.Error("bootstrap bp readings query failed", "error", err)
		bpReadings = []store.BloodPressure{}
	}
	bpGoal, err := s.bp.GetBPGoal()
	if err != nil {
		slog.Error("bootstrap bp goal query failed", "error", err)
		bpGoal = nil
	}
	bpStats, err := s.bp.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		slog.Error("bootstrap bp stats query failed", "error", err)
		bpStats = nil
	}

	weightSince := now.AddDate(0, 0, -35)
	weightLogs, err := s.weight.GetWeightLogs(ctx, userID, weightSince)
	if err != nil {
		slog.Error("bootstrap weight logs query failed", "error", err)
		weightLogs = []store.WeightLog{}
	}
	weightGoal, err := s.weight.GetWeightGoal()
	if err != nil {
		slog.Error("bootstrap weight goal query failed", "error", err)
		weightGoal = nil
	}
	highestRecord, err := s.weight.GetHighestWeightRecord(ctx, userID)
	if err != nil {
		slog.Error("bootstrap highest weight query failed", "error", err)
		highestRecord = nil
	}
	weightGoalResponse := &weightGoalBootstrapResponse{}
	if weightGoal != nil {
		weightGoalResponse.Goal = weightGoal.Goal
		weightGoalResponse.GoalDate = weightGoal.GoalDate
	}
	if highestRecord != nil {
		weightGoalResponse.HighestWeight = &highestRecord.Weight
		weightGoalResponse.HighestDate = &highestRecord.MeasuredAt
	}

	foodTargets, err := s.food.GetFoodTargets(ctx)
	if err != nil {
		slog.Error("bootstrap food targets query failed", "error", err)
		foodTargets = store.FoodTargets{}
	}
	bpReminderStatus, err := s.bp.GetBPReminderState(userID)
	if err != nil {
		slog.Error("bootstrap bp reminder state query failed", "error", err)
		bpReminderStatus = nil
	}
	weightReminderStatus, err := s.weight.GetWeightReminderState(userID)
	if err != nil {
		slog.Error("bootstrap weight reminder state query failed", "error", err)
		weightReminderStatus = nil
	}

	var tabOrder any
	tabOrderOK := true
	tabOrderStr, err := s.settings.GetTabOrder(ctx)
	if err != nil {
		slog.Error("bootstrap tab order query failed", "error", err)
		tabOrderOK = false
	} else if tabOrderStr != "" {
		if err := json.Unmarshal([]byte(tabOrderStr), &tabOrder); err != nil {
			slog.Error("bootstrap invalid tab order json", "error", err)
			tabOrderOK = false
		}
	}

	currentTimezone, err := s.settings.GetCurrentTimezone()
	if err != nil {
		slog.Error("bootstrap timezone query failed", "error", err)
	}

	weightUnitPreference, err := s.settings.GetWeightUnitPreference(ctx)
	if err != nil {
		slog.Error("bootstrap weight unit preference query failed", "error", err)
		weightUnitPreference = "kg"
	}

	// Today's food log groups, scoped to the requesting client's timezone so the
	// cache key matches what loadToday() reads. Without this, an external write
	// (Telegram /food, MCP, another session) can advance the change cursor via a
	// subsequent bootstrap revalidation before the change-poll picks up the
	// 'food' tag — leaving the `food_<date>_day` cache stale indefinitely. BP/
	// weight already ride along in bootstrap; food now matches that pattern.
	foodDate := parseDateInLocation("", r.URL.Query().Get("tz"), r.URL.Query().Get("tz_offset"))
	foodLogs, err := s.food.GetFoodLogs(ctx, userID, foodDate, 1)
	if err != nil {
		slog.Error("bootstrap food logs query failed", "error", err)
		foodLogs = []store.FoodLog{}
	}
	foodGroups := groupFoodLogs(foodLogs, false, foodDate.Location())

	response := map[string]any{
		"cursor":          bootstrapCursor,
		"features":        features,
		"medications":     medications,
		"history_default": historyDefault,
		"bp": map[string]any{
			"readings": bpReadings,
			"goal":     bpGoal,
			"stats":    bpStats,
		},
		"weight": map[string]any{
			"logs": weightLogs,
			"goal": weightGoalResponse,
		},
		"food": map[string]any{
			"date":   foodDate.Format("2006-01-02"),
			"groups": foodGroups,
		},
		"settings": map[string]any{
			"food_targets":           foodTargets,
			"bp_reminder_status":     bpReminderStatus,
			"weight_reminder_status": weightReminderStatus,
			"timezone":               currentTimezone,
			"weight_unit_preference": weightUnitPreference,
		},
	}
	// Only include tab_order when the read succeeded. If it errored, omit the
	// key so the client preserves its local fallback rather than treating a
	// transient backend failure as an explicit reset.
	if tabOrderOK {
		response["settings"].(map[string]any)["tab_order"] = tabOrder
	}
	// Only include next_intake when the computation succeeded. If it errored,
	// omit the key so the client can preserve its cached value rather than
	// treating a transient query failure as "no upcoming dose."
	if nextIntakeOK {
		response["next_intake"] = nextIntake
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSetFeatureEnabled(w http.ResponseWriter, r *http.Request) {
	feature := r.PathValue("feature")
	var req struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var err error
	switch feature {
	case "food":
		err = s.settings.SetFoodIntakeEnabled(ctx, req.Enabled)
	case "bp":
		err = s.settings.SetBloodPressureEnabled(ctx, req.Enabled)
	case "weight":
		err = s.settings.SetWeightEnabled(ctx, req.Enabled)
	case "medication":
		err = s.settings.SetMedicationEnabled(ctx, req.Enabled)
	case "workout":
		err = s.settings.SetWorkoutEnabled(ctx, req.Enabled)
	case "health":
		err = s.settings.SetHealthEnabled(ctx, req.Enabled)
	default:
		http.Error(w, "Unknown feature", http.StatusBadRequest)
		return
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	tz, err := s.settings.GetCurrentTimezone()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	weightUnitPreference, err := s.settings.GetWeightUnitPreference(r.Context())
	if err != nil {
		slog.Error("get settings weight unit preference failed", "error", err)
		weightUnitPreference = "kg"
	}
	now := time.Now()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"timezone":               tz,
		"server_time":            now.Format(time.RFC3339),
		"server_timezone":        formatServerTimezone(now),
		"weight_unit_preference": weightUnitPreference,
	})
}

func formatServerTimezone(now time.Time) string {
	name, offsetSeconds := now.Zone()
	sign := "+"
	if offsetSeconds < 0 {
		sign = "-"
		offsetSeconds = -offsetSeconds
	}
	hours := offsetSeconds / 3600
	minutes := (offsetSeconds % 3600) / 60
	if name == "" {
		return fmt.Sprintf("UTC%s%02d:%02d", sign, hours, minutes)
	}
	return fmt.Sprintf("%s (UTC%s%02d:%02d)", name, sign, hours, minutes)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Timezone string `json:"timezone"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Timezone != "" {
		if _, err := time.LoadLocation(req.Timezone); err != nil {
			http.Error(w, "Invalid timezone: "+req.Timezone, http.StatusBadRequest)
			return
		}
		// Serialize timezone updates so that plan generation + RecordTimezone
		// are never interleaved by a concurrent request.
		s.tzUpdateMu.Lock()
		defer s.tzUpdateMu.Unlock()

		// Capture the current timezone before the update so we can detect a change.
		oldTZ, err := s.settings.GetCurrentTimezone()
		if err != nil {
			slog.Error("handleUpdateSettings: GetCurrentTimezone before update failed", "error", err)
			http.Error(w, "Failed to read current timezone", http.StatusInternalServerError)
			return
		}
		// Generate the transition plan BEFORE writing the new timezone so the
		// scheduler never sees a window where newTZ is stored but no
		// PENDING_APPROVAL plan exists yet.
		// Skip plan generation when no notification channel is configured: the user
		// has no way to receive or approve the plan, so generating it would leave
		// the medication scheduler permanently stuck on the old timezone.
		//
		// Capture the superseded plan's baseline timezone so that if RecordTimezone
		// fails we can fully revert: GenerateIfChanged cancels the existing plan
		// internally, so merely cancelling the new plan isn't enough — the scheduler
		// would fall through to the stored timezone (which may be an unapproved
		// intermediate value). Reverting to the baseline prevents this.
		var supersededBaseline string
		planGenerated := false
		if s.tzPlanner != nil && len(s.notifiers) > 0 && oldTZ != req.Timezone {
			// Capture the active plan's OldTZ before GenerateIfChanged cancels it.
			if s.tzPlanStore != nil {
				if activePlan, planErr := s.tzPlanStore.GetLatestActiveOrPendingTZTransitionPlan(); planErr == nil && activePlan != nil {
					supersededBaseline = activePlan.OldTZ
				}
			}
			created, err := s.tzPlanner.GenerateIfChanged(oldTZ, req.Timezone, time.Now())
			if err != nil {
				slog.Error("handleUpdateSettings: GenerateIfChanged failed, not recording new timezone", "error", err)
				http.Error(w, "Failed to generate timezone transition plan", http.StatusInternalServerError)
				return
			}
			planGenerated = created
		}
		if err := s.settings.RecordTimezone(req.Timezone); err != nil {
			// Plan was created but timezone write failed — cancel the orphaned plan
			// and revert the stored timezone to the baseline that the superseded plan
			// was protecting, so the scheduler doesn't run on an unapproved timezone.
			if planGenerated {
				if cancelErr := s.tzPlanner.CancelActivePlan("record-timezone-failed"); cancelErr != nil {
					slog.Error("handleUpdateSettings: failed to cancel plan after RecordTimezone failure", "error", cancelErr)
				}
			}
			if supersededBaseline != "" && supersededBaseline != oldTZ {
				if revertErr := s.settings.RecordTimezone(supersededBaseline); revertErr != nil {
					slog.Error("handleUpdateSettings: failed to revert timezone to superseded baseline",
						"baseline", supersededBaseline, "error", revertErr)
				} else {
					slog.Info("handleUpdateSettings: reverted stored timezone to superseded plan baseline",
						"baseline", supersededBaseline)
				}
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSetTabOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Order []string `json:"order"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate tab IDs. tab_order now controls Today card order only;
	// 'today' and 'settings' are not cards, so reject them.
	validTabs := map[string]bool{
		"bp":       true,
		"weight":   true,
		"workouts": true,
		"food":     true,
		"health":   true,
		"meds":     true,
	}

	for _, tab := range req.Order {
		if !validTabs[tab] {
			http.Error(w, "Unknown tab ID: "+tab, http.StatusBadRequest)
			return
		}
	}

	ctx := context.Background()
	orderJSON, err := json.Marshal(req.Order)
	if err != nil {
		http.Error(w, "Failed to marshal order", http.StatusInternalServerError)
		return
	}

	if err := s.settings.SetTabOrder(ctx, string(orderJSON)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// handleSetWeightUnitPreference handles PATCH /api/settings/weight-unit.
// It accepts {"unit":"kg"} or {"unit":"lb"} and persists the user's preferred
// weight unit. Storage is always kg; this only affects the input default and
// display in the web app and bot replies.
func (s *Server) handleSetWeightUnitPreference(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Unit string `json:"unit"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Unit != "kg" && req.Unit != "lb" {
		http.Error(w, "unit must be 'kg' or 'lb'", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetWeightUnitPreference(r.Context(), req.Unit); err != nil {
		slog.Error("set weight unit preference failed", "error", err, "unit", req.Unit)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"unit": req.Unit})
}

// handleGetCurrentTZPlan handles GET /api/tz-plan/current.
// Returns the active (PENDING_APPROVAL/NOTIFIED/APPROVED) plan plus its remaining
// steps as JSON, or `{"plan": null}` when there is nothing in flight. The UI uses
// this to decide whether to render the timezone-transition banner; if no plan
// exists, the response is small and the banner stays hidden.
func (s *Server) handleGetCurrentTZPlan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	plan, err := s.tzPlanStore.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		slog.Error("handleGetCurrentTZPlan: GetLatestActiveOrPendingTZTransitionPlan failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if plan == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"plan": nil})
		return
	}

	steps, err := s.tzPlanStore.GetPendingStepsForPlan(plan.ID)
	if err != nil {
		slog.Error("handleGetCurrentTZPlan: GetPendingStepsForPlan failed", "plan_id", plan.ID, "error", err)
		// Fall through with empty steps — surface the plan so the user can still
		// approve or reject it; the banner will just not list per-dose detail.
		steps = nil
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"plan":  plan,
		"steps": steps,
	})
}

// handleTZPlanApprove handles POST /api/tz-plan/{id}/approve.
// It transitions the plan to APPROVED so the medication scheduler can execute it.
func (s *Server) handleTZPlanApprove(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	planID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid plan id", http.StatusBadRequest)
		return
	}
	updated, err := s.tzPlanStore.SetTZTransitionPlanApproved(planID, time.Now())
	if err != nil {
		slog.Error("handleTZPlanApprove: SetTZTransitionPlanApproved failed", "plan_id", planID, "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !updated {
		http.Error(w, "plan not found or no longer pending", http.StatusConflict)
		return
	}
	slog.Info("tz_plan: approved via web", "plan_id", planID)
	w.WriteHeader(http.StatusOK)
}

// handleTZPlanReject handles POST /api/tz-plan/{id}/reject.
// It transitions the plan to REJECTED and reverts the stored timezone.
func (s *Server) handleTZPlanReject(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	planID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid plan id", http.StatusBadRequest)
		return
	}
	updated, err := s.tzPlanStore.RejectTZTransitionPlanAndRevertTimezone(planID)
	if err != nil {
		slog.Error("handleTZPlanReject: RejectTZTransitionPlanAndRevertTimezone failed", "plan_id", planID, "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !updated {
		http.Error(w, "plan not found or no longer pending", http.StatusConflict)
		return
	}
	slog.Info("tz_plan: rejected via web", "plan_id", planID)
	w.WriteHeader(http.StatusOK)
}
