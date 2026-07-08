package server

import (
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// handleVaultExport streams the authed user's entire dataset as a single
// canonical vault JSON (see docs/vault-format.md). Additive to bot mode: it
// only reads through existing repo methods and never mutates state. The cloud
// runtime produces the same shape client-side (window.CloudVault), so a file
// from either mode imports into the other.
func (s *Server) handleVaultExport(w http.ResponseWriter, r *http.Request) {
	// Demo mode bypasses auth (every request is the shared seeded user), so the
	// export — which dumps the settings singleton's plaintext integration API
	// keys (masked on every other endpoint) — would leak the operator's real
	// OpenAI/ElevenLabs secrets to any anonymous visitor. Block it.
	if s.demoMode {
		http.Error(w, "not available in demo mode", http.StatusForbidden)
		return
	}
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// A full vault is every domain over all history: the repo walk plus the
	// encode of tens of MB routinely outruns http.Server.WriteTimeout (45s),
	// which killed the socket mid-encode with "i/o timeout". Same escape hatch
	// the SSE stream uses (changes_handlers.go), but bounded rather than cleared.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(vaultIOTimeout))

	// include_secrets: absent → include (the vault is a migration mechanism
	// first). "0"/"false" → omit api_tokens + settings.integrations so the file
	// can be shared or stored casually. See docs/vault-format.md.
	includeSecrets := true
	switch r.URL.Query().Get("include_secrets") {
	case "0", "false":
		includeSecrets = false
	}

	started := time.Now()
	vault, err := s.buildVault(r.Context(), userID, includeSecrets)
	if err != nil {
		slog.Error("vault export failed", "error", err, "user_id", userID)
		http.Error(w, "export failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=medtracker-vault-%s.json", time.Now().UTC().Format("2006-01-02")))

	// Compress on the wire: a full vault is highly repetitive JSON and gzips
	// ~10x. fetch/XHR decompress transparently, so callers see plain JSON.
	// Vary because the same URL now has two representations.
	w.Header().Set("Vary", "Accept-Encoding")
	out := io.Writer(w)
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer func() { _ = gz.Close() }()
		out = gz
	}

	// ponytail: no SetIndent — the browser re-indents for the saved file
	// (importexport.js JSON.stringify(vault, null, 2)), so indenting here only
	// inflates the wire. `age -d | jq` prettifies the file for anyone else.
	if err := json.NewEncoder(out).Encode(vault); err != nil {
		slog.Error("vault export encode failed", "error", err, "user_id", userID)
		return
	}
	slog.Info("vault export sent", "user_id", userID, "build_duration", time.Since(started))
}

// buildVault walks every domain repo for one user and assembles the canonical
// struct set. It converts storage time forms to the wire form only where the
// repo doesn't already return time.Time (intake unix-seconds and vitals
// unix-millis are already time.Time on their structs; mi-band millisecond
// fields stay raw int64 per the format).
//
// includeSecrets=false leaves Settings.Integrations nil and APITokens nil —
// both are pointers, and "absent" is what tells the importer to leave the
// destination's existing secrets alone.
func (s *Server) buildVault(ctx context.Context, userID int64, includeSecrets bool) (*Vault, error) {
	var data VaultData
	var zero time.Time
	// ponytail: repo list methods are windowed by since/days/limit; a
	// far-future ceiling + huge limit turns them into full dumps without new
	// store methods. Upgrade path: dedicated ListAll* methods if a real query
	// ever needs to distinguish "everything" from "a very wide window".
	far := time.Now().AddDate(200, 0, 0)
	const noLimit = 1_000_000

	if err := s.exportMedications(ctx, userID, &data, zero, far); err != nil {
		return nil, err
	}
	if err := s.exportBP(ctx, userID, &data, zero); err != nil {
		return nil, err
	}
	if err := s.exportWeight(ctx, userID, &data, zero); err != nil {
		return nil, err
	}
	if err := s.exportFood(ctx, userID, &data, far, noLimit); err != nil {
		return nil, err
	}
	if err := s.exportWorkouts(ctx, userID, &data, noLimit); err != nil {
		return nil, err
	}
	if err := s.exportVitals(ctx, userID, &data, zero, far); err != nil {
		return nil, err
	}
	if err := s.exportDiary(ctx, userID, &data, zero, far, noLimit); err != nil {
		return nil, err
	}
	if err := s.exportTZ(ctx, &data); err != nil {
		return nil, err
	}
	if err := s.exportSettings(ctx, &data, includeSecrets); err != nil {
		return nil, err
	}
	if err := s.exportReminderState(ctx, userID, &data); err != nil {
		return nil, err
	}
	if err := s.exportGamification(ctx, userID, &data); err != nil {
		return nil, err
	}
	if includeSecrets {
		if err := s.exportAPITokens(ctx, &data); err != nil {
			return nil, err
		}
	}

	return &Vault{
		Format:     vaultFormat,
		Version:    vaultVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Data:       data,
	}, nil
}

func (s *Server) exportMedications(ctx context.Context, userID int64, data *VaultData, zero, far time.Time) error {
	meds, err := s.store.Medication.List(true)
	if err != nil {
		return fmt.Errorf("list medications: %w", err)
	}
	for _, m := range meds {
		data.Medications.Items = append(data.Medications.Items, VaultMedication{
			ID:             m.ID,
			Name:           m.Name,
			Dosage:         m.Dosage,
			Schedule:       m.Schedule,
			Archived:       m.Archived,
			Supplement:     m.Supplement,
			StartDate:      m.StartDate,
			EndDate:        m.EndDate,
			RxCUI:          m.RxCUI,
			NormalizedName: m.NormalizedName,
			InventoryCount: m.InventoryCount,
			TZShiftPolicy:  m.TZShiftPolicy,
			CreatedAt:      m.CreatedAt,
		})
		restocks, err := s.store.Medication.ListRestocks(m.ID)
		if err != nil {
			return fmt.Errorf("list restocks: %w", err)
		}
		for _, rs := range restocks {
			data.Medications.Restocks = append(data.Medications.Restocks, VaultRestock{
				MedicationID: rs.MedicationID,
				Quantity:     rs.Quantity,
				Note:         rs.Note,
				RestockedAt:  rs.RestockedAt,
			})
		}
	}

	intakes, err := s.store.Medication.ListIntakeHistoryByUser(ctx, userID, zero, far)
	if err != nil {
		return fmt.Errorf("list intakes: %w", err)
	}
	for _, in := range intakes {
		data.Medications.Intakes = append(data.Medications.Intakes, VaultIntake{
			MedicationID: in.MedicationID,
			ScheduledAt:  in.ScheduledAt,
			TakenAt:      in.TakenAt,
			Status:       in.Status,
			SnoozedUntil: in.SnoozedUntil,
			Source:       in.Source,
		})
	}
	return nil
}

func (s *Server) exportBP(ctx context.Context, userID int64, data *VaultData, zero time.Time) error {
	readings, err := s.store.BP.ListReadings(ctx, userID, zero)
	if err != nil {
		return fmt.Errorf("list bp: %w", err)
	}
	for _, b := range readings {
		data.BP.Readings = append(data.BP.Readings, VaultBPReading{
			MeasuredAt: b.MeasuredAt,
			Systolic:   b.Systolic,
			Diastolic:  b.Diastolic,
			Pulse:      b.Pulse,
			Site:       b.Site,
			Position:   b.Position,
			IgnoreCalc: b.IgnoreCalc,
			Notes:      b.Notes,
			Tag:        b.Tag,
		})
	}
	goal, err := s.store.BP.GetGoal()
	if err != nil {
		return fmt.Errorf("bp goal: %w", err)
	}
	if goal != nil && (goal.TargetSystolic != nil || goal.TargetDiastolic != nil) {
		data.BP.Goal = &VaultBPGoal{TargetSystolic: goal.TargetSystolic, TargetDiastolic: goal.TargetDiastolic}
	}
	return nil
}

func (s *Server) exportWeight(ctx context.Context, userID int64, data *VaultData, zero time.Time) error {
	logs, err := s.store.Weight.ListLogs(ctx, userID, zero)
	if err != nil {
		return fmt.Errorf("list weight: %w", err)
	}
	for _, wl := range logs {
		data.Weight.Logs = append(data.Weight.Logs, VaultWeightLog{
			MeasuredAt: wl.MeasuredAt,
			Weight:     wl.Weight,
			BodyFat:    wl.BodyFat,
			MuscleMass: wl.MuscleMass,
			Notes:      wl.Notes,
		})
	}
	// Goal history is append-only user data — export all of it, oldest first
	// (ListGoals returns newest first).
	goals, err := s.store.Weight.ListGoals(ctx, userID, 0)
	if err != nil {
		return fmt.Errorf("list weight goals: %w", err)
	}
	for i := len(goals) - 1; i >= 0; i-- {
		g := goals[i]
		data.Weight.Goals = append(data.Weight.Goals, VaultWeightGoal{
			TargetWeight: g.TargetWeight,
			TargetDate:   g.TargetDate,
			SetAt:        g.SetAt,
			StartWeight:  g.StartWeight,
		})
	}
	if len(goals) == 0 {
		// No history row: a pre-history user may still have a goal in the
		// legacy singleton settings columns, which GetGoal falls back to.
		goal, gerr := s.store.Weight.GetGoal(ctx, userID)
		if gerr != nil {
			return fmt.Errorf("weight goal: %w", gerr)
		}
		if goal != nil && goal.Goal != nil {
			vg := VaultWeightGoal{
				TargetWeight: *goal.Goal,
				SetAt:        derefTime(goal.GoalSetAt),
				StartWeight:  goal.GoalStartWeight,
			}
			if goal.GoalDate != nil {
				vg.TargetDate = goal.GoalDate.Format("2006-01-02")
			}
			data.Weight.Goals = append(data.Weight.Goals, vg)
		}
	}
	unit, err := s.store.Weight.GetUnitPreference(ctx)
	if err != nil {
		return fmt.Errorf("weight unit: %w", err)
	}
	if unit != "" {
		data.Weight.UnitPref = &unit
	}
	return nil
}

func (s *Server) exportFood(ctx context.Context, userID int64, data *VaultData, far time.Time, noLimit int) error {
	logs, err := s.store.Food.ListLogs(ctx, userID, far, noLimit)
	if err != nil {
		return fmt.Errorf("list food logs: %w", err)
	}
	for _, fl := range logs {
		data.Food.Logs = append(data.Food.Logs, VaultFoodLog{
			EatenAt:   fl.EatenAt,
			Name:      fl.Name,
			Weight:    fl.Weight,
			Calories:  fl.Calories,
			Carbs:     fl.Carbs,
			Protein:   fl.Protein,
			Fat:       fl.Fat,
			IsMeal:    fl.IsMeal,
			ProductID: fl.ProductID,
		})
	}
	products, _, err := s.store.Food.ListProducts(ctx, userID, store.FoodProductsFilter{Limit: noLimit})
	if err != nil {
		return fmt.Errorf("list food products: %w", err)
	}
	for _, p := range products {
		data.Food.Products = append(data.Food.Products, VaultFoodProduct{
			ID:             p.ID,
			Name:           p.Name,
			Barcode:        p.Barcode,
			Carbs100g:      p.Carbs100g,
			Protein100g:    p.Protein100g,
			Fat100g:        p.Fat100g,
			EnergyKcal100g: p.EnergyKcal100g,
			UsageCount:     p.UsageCount,
			IsMeal:         p.IsMeal,
			TotalWeightG:   p.TotalWeightG,
			CreatedAt:      p.CreatedAt,
			LastUsedAt:     p.LastUsedAt,
		})
	}
	return nil
}

func (s *Server) exportWorkouts(ctx context.Context, userID int64, data *VaultData, noLimit int) error {
	groups, err := s.store.Workout.ListGroups(userID, false)
	if err != nil {
		return fmt.Errorf("list workout groups: %w", err)
	}
	for _, g := range groups {
		data.Workouts.Groups = append(data.Workouts.Groups, VaultWorkoutGroup{
			ID:                         g.ID,
			UserID:                     g.UserID,
			Name:                       g.Name,
			Description:                g.Description,
			IsRotating:                 g.IsRotating,
			DaysOfWeek:                 g.DaysOfWeek,
			ScheduledTime:              g.ScheduledTime,
			NotificationAdvanceMinutes: g.NotificationAdvanceMinutes,
			Active:                     g.Active,
			CreatedAt:                  g.CreatedAt,
			UpdatedAt:                  g.UpdatedAt,
		})
		variants, err := s.store.Workout.ListVariantsByGroup(g.ID)
		if err != nil {
			return fmt.Errorf("list variants: %w", err)
		}
		for _, v := range variants {
			data.Workouts.Variants = append(data.Workouts.Variants, VaultWorkoutVariant{
				ID:            v.ID,
				GroupID:       v.GroupID,
				Name:          v.Name,
				RotationOrder: v.RotationOrder,
				Description:   v.Description,
				CreatedAt:     v.CreatedAt,
			})
			exs, err := s.store.Workout.ListExercisesByVariant(v.ID)
			if err != nil {
				return fmt.Errorf("list exercises: %w", err)
			}
			for _, e := range exs {
				data.Workouts.Exercises = append(data.Workouts.Exercises, VaultWorkoutExercise{
					ID:             e.ID,
					VariantID:      e.VariantID,
					ExerciseName:   e.ExerciseName,
					TargetSets:     e.TargetSets,
					TargetRepsMin:  e.TargetRepsMin,
					TargetRepsMax:  e.TargetRepsMax,
					TargetWeightKg: e.TargetWeightKg,
					OrderIndex:     e.OrderIndex,
				})
			}
		}
		rot, err := s.store.Workout.GetRotationState(g.ID)
		if err != nil {
			return fmt.Errorf("rotation state: %w", err)
		}
		if rot != nil {
			data.Workouts.Rotations = append(data.Workouts.Rotations, VaultRotation{
				GroupID:          rot.GroupID,
				CurrentVariantID: rot.CurrentVariantID,
				LastSessionDate:  rot.LastSessionDate,
				UpdatedAt:        rot.UpdatedAt,
			})
		}
	}

	lib, err := s.store.Workout.ListExerciseLibrary(userID)
	if err != nil {
		return fmt.Errorf("list library: %w", err)
	}
	for _, l := range lib {
		data.Workouts.Library = append(data.Workouts.Library, VaultLibraryEntry{
			ID:              l.ID,
			UserID:          l.UserID,
			Name:            l.Name,
			DefaultSets:     l.DefaultSets,
			DefaultRepsMin:  l.DefaultRepsMin,
			DefaultRepsMax:  l.DefaultRepsMax,
			DefaultWeightKg: l.DefaultWeightKg,
			Notes:           l.Notes,
			CreatedAt:       l.CreatedAt,
			UpdatedAt:       l.UpdatedAt,
		})
	}

	sessions, err := s.store.Workout.ListHistory(userID, noLimit)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	for _, ses := range sessions {
		data.Workouts.Sessions = append(data.Workouts.Sessions, VaultSession{
			ID:                    ses.ID,
			UserID:                ses.UserID,
			GroupID:               ses.GroupID,
			VariantID:             ses.VariantID,
			ScheduledDate:         ses.ScheduledDate,
			ScheduledTime:         ses.ScheduledTime,
			Status:                ses.Status,
			StartedAt:             ses.StartedAt,
			CompletedAt:           ses.CompletedAt,
			SnoozedUntil:          ses.SnoozedUntil,
			SnoozeCount:           ses.SnoozeCount,
			NotificationMessageID: ses.NotificationMessageID,
			Notes:                 ses.Notes,
		})
		elogs, err := s.store.Workout.ListExerciseLogs(ses.ID)
		if err != nil {
			return fmt.Errorf("list exercise logs: %w", err)
		}
		for _, el := range elogs {
			data.Workouts.ExerciseLogs = append(data.Workouts.ExerciseLogs, VaultExerciseLog{
				SessionID:     el.SessionID,
				ExerciseID:    el.ExerciseID,
				ExerciseName:  el.ExerciseName,
				SetsCompleted: el.SetsCompleted,
				RepsCompleted: el.RepsCompleted,
				WeightKg:      el.WeightKg,
				Status:        el.Status,
				Notes:         el.Notes,
				LoggedAt:      el.LoggedAt,
				Source:        el.Source,
			})
		}
	}

	return s.exportMiBand(ctx, userID, data)
}

// exportMiBand reads mi-band workouts + GPS directly. The typed ListMiBand
// caps at the last 90 days (a UI concern); a portable backup must carry every
// workout, so this queries without the cutoff.
func (s *Server) exportMiBand(ctx context.Context, userID int64, data *VaultData) error {
	rows, err := s.store.DB().QueryContext(ctx, `
		SELECT id, source_start_ms, source_end_ms, activity_type, activity_name,
		       duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
		       pause_ms, tz_offset, source
		FROM miband_workouts
		WHERE user_id = ?
		ORDER BY source_start_ms ASC`, userID)
	if err != nil {
		return fmt.Errorf("list miband: %w", err)
	}
	defer rows.Close()

	var ids []int64
	var workouts []VaultMiBand
	for rows.Next() {
		var id int64
		var w VaultMiBand
		if err := rows.Scan(&id, &w.SourceStartMs, &w.SourceEndMs, &w.ActivityType, &w.ActivityName,
			&w.DurationSec, &w.DistanceM, &w.Steps, &w.Calories, &w.HeartRateAvg, &w.SpO2Avg,
			&w.PauseMs, &w.TzOffset, &w.Source); err != nil {
			return fmt.Errorf("scan miband: %w", err)
		}
		ids = append(ids, id)
		workouts = append(workouts, w)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("miband rows: %w", err)
	}

	for i := range workouts {
		gps, err := s.store.Workout.GetMiBandGPS(ctx, ids[i])
		if err != nil {
			return fmt.Errorf("miband gps: %w", err)
		}
		for _, pt := range gps {
			workouts[i].GPS = append(workouts[i].GPS, VaultGPSPoint{
				PointIndex: pt.PointIndex,
				TsMs:       pt.TsMs,
				Latitude:   pt.Latitude,
				Longitude:  pt.Longitude,
				Altitude:   pt.Altitude,
				IsPause:    pt.IsPause,
			})
		}
	}
	data.Workouts.MiBand = workouts
	return nil
}

func (s *Server) exportVitals(ctx context.Context, userID int64, data *VaultData, zero, far time.Time) error {
	sleep, err := s.store.Vitals.ListSleepLogs(ctx, userID, zero)
	if err != nil {
		return fmt.Errorf("list sleep: %w", err)
	}
	for _, sl := range sleep {
		data.Vitals.Sleep = append(data.Vitals.Sleep, VaultSleep{
			StartTime:      sl.StartTime,
			EndTime:        sl.EndTime,
			TimezoneOffset: sl.TimezoneOffset,
			// sleep_logs.day is a DATE-affinity column, so modernc returns it as
			// an RFC3339 timestamp ("2026-07-08T00:00:00Z"); the canonical format
			// (and the cloud record body) use a plain YYYY-MM-DD date. Trim to the
			// date so bot and cloud exports agree.
			Day: dateOnly(sl.Day),
			LightMinutes:   sl.LightMinutes,
			DeepMinutes:    sl.DeepMinutes,
			REMMinutes:     sl.REMMinutes,
			AwakeMinutes:   sl.AwakeMinutes,
			TotalMinutes:   sl.TotalMinutes,
			TurnOverCount:  sl.TurnOverCount,
			HeartRateAvg:   sl.HeartRateAvg,
			SpO2Avg:        sl.SpO2Avg,
			UserModified:   sl.UserModified,
			Notes:          sl.Notes,
		})
	}
	days, err := s.store.Vitals.ListDayStats(ctx, userID, zero)
	if err != nil {
		return fmt.Errorf("list day stats: %w", err)
	}
	for _, d := range days {
		data.Vitals.DayStats = append(data.Vitals.DayStats, VaultDayStat{
			Day: d.Day, Steps: d.Steps, Calories: d.Calories, Distance: d.Distance,
		})
	}
	heart, err := s.store.Vitals.ListHeart(ctx, userID, zero, far)
	if err != nil {
		return fmt.Errorf("list heart: %w", err)
	}
	for _, h := range heart {
		data.Vitals.Heart = append(data.Vitals.Heart, VaultSample{
			DateTime: h.DateTime, TzOffset: h.TzOffset, Value: h.Value,
		})
	}
	spo2, err := s.store.Vitals.ListSpO2(ctx, userID, zero, far)
	if err != nil {
		return fmt.Errorf("list spo2: %w", err)
	}
	for _, sp := range spo2 {
		data.Vitals.SpO2 = append(data.Vitals.SpO2, VaultSample{
			DateTime: sp.DateTime, TzOffset: sp.TzOffset, Value: sp.Value,
		})
	}
	stress, err := s.store.Vitals.ListStress(ctx, userID, zero, far)
	if err != nil {
		return fmt.Errorf("list stress: %w", err)
	}
	for _, st := range stress {
		data.Vitals.Stress = append(data.Vitals.Stress, VaultSample{
			DateTime: st.DateTime, TzOffset: st.TzOffset, Value: st.Value, Info: st.Info,
		})
	}
	return nil
}

func (s *Server) exportDiary(ctx context.Context, userID int64, data *VaultData, zero, far time.Time, noLimit int) error {
	notes, err := s.store.Diary.List(ctx, userID, zero, far, noLimit, 0)
	if err != nil {
		return fmt.Errorf("list diary: %w", err)
	}
	for _, n := range notes {
		data.Diary.Notes = append(data.Diary.Notes, VaultNote{
			Content: n.Content, Tag: n.Tag, CreatedAt: n.CreatedAt,
		})
	}
	return nil
}

func (s *Server) exportTZ(ctx context.Context, data *VaultData) error {
	cur, err := s.store.TZ.GetCurrent()
	if err != nil {
		return fmt.Errorf("tz current: %w", err)
	}
	if cur != "" {
		data.TZ.Current = &cur
	}

	rows, err := s.store.DB().QueryContext(ctx,
		`SELECT timezone, recorded_at FROM timezone_history ORDER BY recorded_at ASC`)
	if err != nil {
		return fmt.Errorf("tz history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var change VaultTZChange
		if err := rows.Scan(&change.Timezone, &change.ChangedAt); err != nil {
			return fmt.Errorf("scan tz history: %w", err)
		}
		data.TZ.History = append(data.TZ.History, change)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("tz history rows: %w", err)
	}

	// Every plan, oldest first: the typed getter returns only the latest
	// active/pending one, but the wipe deletes the whole table and past plans
	// feed history analysis. Steps live entirely in steps_json — the separate
	// tz_transition_steps table was dropped in migration 069.
	planRows, err := s.store.DB().QueryContext(ctx, `
		SELECT old_tz, new_tz, status, created_at_unix, approved_at_unix, notified_at_unix,
		       plan_hash, inputs_json, COALESCE(user_action, ''), steps_json
		FROM tz_transition_plans
		ORDER BY created_at_unix ASC, id ASC`)
	if err != nil {
		return fmt.Errorf("tz plans: %w", err)
	}
	defer planRows.Close()
	for planRows.Next() {
		var p VaultTZPlan
		var createdUnix int64
		var approvedUnix, notifiedUnix *int64
		var stepsJSON string
		if err := planRows.Scan(&p.OldTZ, &p.NewTZ, &p.Status, &createdUnix, &approvedUnix, &notifiedUnix,
			&p.PlanHash, &p.InputsJSON, &p.UserAction, &stepsJSON); err != nil {
			return fmt.Errorf("scan tz plan: %w", err)
		}
		p.CreatedAt = time.Unix(createdUnix, 0).UTC()
		p.ApprovedAt = unixPtrToTime(approvedUnix)
		p.NotifiedAt = unixPtrToTime(notifiedUnix)
		if stepsJSON != "" {
			var steps []tzreschedule.TransitionStep
			if err := json.Unmarshal([]byte(stepsJSON), &steps); err != nil {
				return fmt.Errorf("parse tz steps: %w", err)
			}
			for _, st := range steps {
				p.Steps = append(p.Steps, VaultTZStep{
					MedicationID: st.MedicationID,
					MedName:      st.MedName,
					StepNumber:   st.StepNumber,
					TotalSteps:   st.TotalSteps,
					ScheduledAt:  st.ScheduledAt,
					Note:         st.Note,
				})
			}
		}
		data.TZ.TransitionPlans = append(data.TZ.TransitionPlans, p)
	}
	return planRows.Err()
}

func unixPtrToTime(n *int64) *time.Time {
	if n == nil {
		return nil
	}
	t := time.Unix(*n, 0).UTC()
	return &t
}

func (s *Server) exportSettings(ctx context.Context, data *VaultData, includeSecrets bool) error {
	cur, err := s.store.TZ.GetCurrent()
	if err != nil {
		return fmt.Errorf("settings timezone: %w", err)
	}
	data.Settings.Timezone = cur

	dismissed, err := s.store.Settings.GetDismissedTZSuggestion(ctx)
	if err != nil {
		return fmt.Errorf("dismissed tz: %w", err)
	}
	data.Settings.DismissedTZSuggestion = dismissed

	features, err := s.exportFeatures(ctx)
	if err != nil {
		return err
	}
	data.Settings.Features = features

	tabJSON, err := s.store.Settings.GetTabOrder(ctx)
	if err != nil {
		return fmt.Errorf("tab order: %w", err)
	}
	if tabJSON != "" {
		if err := json.Unmarshal([]byte(tabJSON), &data.Settings.TabOrder); err != nil {
			return fmt.Errorf("parse tab order: %w", err)
		}
	}

	targets, err := s.store.Food.GetTargets(ctx)
	if err != nil {
		return fmt.Errorf("food targets: %w", err)
	}
	data.Settings.FoodTargets = &VaultFoodTargets{
		Calories: targets.Calories,
		Carbs:    targets.Carbs,
		Protein:  targets.Protein,
		Fat:      targets.Fat,
	}

	if !includeSecrets {
		// Nil Integrations == "leave the destination's provider keys alone".
		// med_reminder_pref is a cloud-only singleton; bot mode has no such row.
		return nil
	}

	oa, err := s.store.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		return fmt.Errorf("integration openai: %w", err)
	}
	fi, err := s.store.Settings.GetIntegrationFood(ctx)
	if err != nil {
		return fmt.Errorf("integration food: %w", err)
	}
	el, err := s.store.Settings.GetIntegrationElevenLabs(ctx)
	if err != nil {
		return fmt.Errorf("integration elevenlabs: %w", err)
	}
	data.Settings.Integrations = &VaultIntegrations{
		OpenAI: VaultOpenAI{
			APIKey:       oa.APIKey,
			URL:          oa.URL,
			Model:        oa.Model,
			VisionAPIKey: oa.VisionAPIKey,
			VisionURL:    oa.VisionURL,
			VisionModel:  oa.VisionModel,
		},
		Food:       VaultFoodIntegration{APIKey: fi.APIKey, URL: fi.URL, Domain: fi.Domain},
		ElevenLabs: VaultElevenLabs{APIKey: el.APIKey, AgentID: el.AgentID},
	}
	// med_reminder_pref is a cloud-only singleton; bot mode has no such row, so
	// it is intentionally left nil (omitempty drops it from bot exports).
	return nil
}

// exportReminderState carries the two scheduler-owned reminder rows. Only the
// user-set fields travel; last_notification_sent_at / notification_message_id
// are transient scheduler + Telegram state that must not follow a restore.
func (s *Server) exportReminderState(ctx context.Context, userID int64, data *VaultData) error {
	read := func(table string) (*VaultReminderState, error) {
		var st VaultReminderState
		err := s.store.DB().QueryRowContext(ctx, `
			SELECT enabled, COALESCE(preferred_reminder_hour, 0), snoozed_until, dont_remind_until
			FROM `+table+` WHERE user_id = ?`, userID).
			Scan(&st.Enabled, &st.PreferredReminderHour, &st.SnoozedUntil, &st.DontRemindUntil)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", table, err)
		}
		return &st, nil
	}

	bp, err := read("bp_reminder_state")
	if err != nil {
		return err
	}
	data.Settings.BPReminder = bp

	wt, err := read("weight_reminder_state")
	if err != nil {
		return err
	}
	data.Settings.WeightReminder = wt
	return nil
}

func (s *Server) exportGamification(ctx context.Context, userID int64, data *VaultData) error {
	targetRows, err := s.store.DB().QueryContext(ctx, `
		SELECT metric_key, low_val, high_val, falloff, mode, updated_at_unix
		FROM gamification_targets WHERE user_id = ? ORDER BY metric_key ASC`, userID)
	if err != nil {
		return fmt.Errorf("gamification targets: %w", err)
	}
	defer targetRows.Close()
	for targetRows.Next() {
		var t VaultGamTarget
		var updated int64
		if err := targetRows.Scan(&t.MetricKey, &t.LowVal, &t.HighVal, &t.Falloff, &t.Mode, &updated); err != nil {
			return fmt.Errorf("scan gamification target: %w", err)
		}
		t.UpdatedAt = time.Unix(updated, 0).UTC()
		data.Gamification.Targets = append(data.Gamification.Targets, t)
	}
	if err := targetRows.Err(); err != nil {
		return fmt.Errorf("gamification target rows: %w", err)
	}

	ledgerRows, err := s.store.DB().QueryContext(ctx, `
		SELECT day_unix, ring, source_metric, kind, hp, detail, created_at_unix
		FROM gamification_ledger WHERE user_id = ?
		ORDER BY day_unix ASC, ring ASC, source_metric ASC, kind ASC`, userID)
	if err != nil {
		return fmt.Errorf("gamification ledger: %w", err)
	}
	defer ledgerRows.Close()
	for ledgerRows.Next() {
		var e VaultGamLedgerEntry
		var day, created int64
		if err := ledgerRows.Scan(&day, &e.Ring, &e.SourceMetric, &e.Kind, &e.HP, &e.Detail, &created); err != nil {
			return fmt.Errorf("scan gamification ledger: %w", err)
		}
		e.Day = time.Unix(day, 0).UTC()
		e.CreatedAt = time.Unix(created, 0).UTC()
		data.Gamification.Ledger = append(data.Gamification.Ledger, e)
	}
	if err := ledgerRows.Err(); err != nil {
		return fmt.Errorf("gamification ledger rows: %w", err)
	}

	var st VaultGamState
	var lastScored, backfilled *int64
	var updated int64
	err = s.store.DB().QueryRowContext(ctx, `
		SELECT lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier,
		       last_scored_day_unix, backfilled_at_unix, updated_at_unix
		FROM gamification_state WHERE user_id = ?`, userID).
		Scan(&st.LifetimeHP, &st.Level, &st.CurrentStreak, &st.LongestStreak, &st.Freezes,
			&st.InsightTier, &lastScored, &backfilled, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("gamification state: %w", err)
	}
	st.LastScoredDay = unixPtrToTime(lastScored)
	st.BackfilledAt = unixPtrToTime(backfilled)
	st.UpdatedAt = time.Unix(updated, 0).UTC()
	data.Gamification.State = &st
	return nil
}

// exportAPITokens carries token_hash, not the (unrecoverable) plaintext — which
// is exactly what makes an already-minted MCP/API token keep authenticating
// after a server move. Only reached when include_secrets is on.
func (s *Server) exportAPITokens(ctx context.Context, data *VaultData) error {
	rows, err := s.store.DB().QueryContext(ctx,
		`SELECT name, token_hash, created_at, last_used_at FROM api_tokens ORDER BY id ASC`)
	if err != nil {
		return fmt.Errorf("api tokens: %w", err)
	}
	defer rows.Close()
	tokens := []VaultAPIToken{}
	for rows.Next() {
		var t VaultAPIToken
		if err := rows.Scan(&t.Name, &t.TokenHash, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return fmt.Errorf("scan api token: %w", err)
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("api token rows: %w", err)
	}
	data.APITokens = &tokens
	return nil
}

func (s *Server) exportFeatures(ctx context.Context) (VaultFeatures, error) {
	var f VaultFeatures
	get := func(dst **bool, fn func(context.Context) (bool, error), name string) error {
		v, err := fn(ctx)
		if err != nil {
			return fmt.Errorf("feature %s: %w", name, err)
		}
		*dst = &v
		return nil
	}
	for _, g := range []struct {
		dst  **bool
		fn   func(context.Context) (bool, error)
		name string
	}{
		{&f.Food, s.store.Settings.GetFoodIntakeEnabled, "food"},
		{&f.BP, s.store.Settings.GetBloodPressureEnabled, "bp"},
		{&f.Weight, s.store.Settings.GetWeightEnabled, "weight"},
		{&f.Medication, s.store.Settings.GetMedicationEnabled, "medication"},
		{&f.Workout, s.store.Settings.GetWorkoutEnabled, "workout"},
		{&f.Health, s.store.Settings.GetHealthEnabled, "health"},
		{&f.Gamification, s.store.Settings.GetGamificationEnabled, "gamification"},
		{&f.WeeklyDigest, s.store.Settings.GetWeeklyDigestEnabled, "weekly_digest"},
	} {
		if err := get(g.dst, g.fn, g.name); err != nil {
			return f, err
		}
	}
	return f, nil
}

func derefTime(t *time.Time) time.Time {
	if t != nil {
		return *t
	}
	return time.Time{}
}

// dateOnly trims a possibly-timestamped day string to its YYYY-MM-DD prefix.
func dateOnly(day string) string {
	if len(day) >= 10 {
		return day[:10]
	}
	return day
}
