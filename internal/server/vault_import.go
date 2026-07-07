package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
)

// vaultImportRequest is the POST /api/import body: a canonical vault file
// (vault_format.go) plus an explicit "mode" flag. Only "replace" is supported
// in v1 — the whole user is wiped, then rebuilt from the file. The flag makes
// the destructive intent explicit at the wire level (the UI also confirms).
type vaultImportRequest struct {
	Vault
	Mode string `json:"mode"`
}

// handleVaultImport replaces the authed user's entire dataset with the posted
// canonical vault (see docs/vault-format.md). Additive to bot mode. It is
// all-or-nothing: parse + validate fully BEFORE touching the DB, then wipe and
// re-insert inside a single transaction so a mid-insert failure leaves the
// prior data intact.
func (s *Server) handleVaultImport(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req vaultImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid JSON: %v", err), http.StatusBadRequest)
		return
	}
	if errs := validateVault(&req); len(errs) > 0 {
		writeVaultErrors(w, errs)
		return
	}

	if err := s.importVault(r.Context(), userID, &req.Vault); err != nil {
		slog.Error("vault import failed", "error", err, "user_id", userID)
		http.Error(w, "import failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "mode": "replace"})
}

func validateVault(req *vaultImportRequest) []string {
	var errs []string
	if req.Format != vaultFormat {
		errs = append(errs, fmt.Sprintf("unknown format %q (want %q)", req.Format, vaultFormat))
	}
	if req.Version != vaultVersion {
		errs = append(errs, fmt.Sprintf("unsupported version %d (want %d)", req.Version, vaultVersion))
	}
	if req.Mode != "replace" {
		errs = append(errs, fmt.Sprintf("unsupported mode %q (want \"replace\")", req.Mode))
	}
	return errs
}

func writeVaultErrors(w http.ResponseWriter, errs []string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "errors": errs})
}

// importVault wipes the user and re-inserts every domain from the vault inside
// one transaction. Inserts are raw SQL that write the wire values verbatim
// (mirroring the raw reads in vault_export.go), preserving FK-glue numeric IDs
// so intakes/logs/sessions still resolve after import.
// ponytail: raw INSERTs, not store Create methods — the round-trip contract
// needs exact field + explicit-ID fidelity, which auto-ID / default-stamping
// Create methods can't give. Upgrade path: none needed; symmetric with export.
func (s *Server) importVault(ctx context.Context, userID int64, v *Vault) error {
	tx, err := s.store.DB().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := seeddemo.WipeUserTx(ctx, tx, userID); err != nil {
		return fmt.Errorf("wipe: %w", err)
	}

	d := &v.Data
	steps := []struct {
		name string
		fn   func() error
	}{
		{"medications", func() error { return importMedications(ctx, tx, userID, d) }},
		{"bp", func() error { return importBP(ctx, tx, userID, d) }},
		{"weight", func() error { return importWeight(ctx, tx, userID, d) }},
		{"food", func() error { return importFood(ctx, tx, userID, d) }},
		{"workouts", func() error { return importWorkouts(ctx, tx, userID, d) }},
		{"vitals", func() error { return importVitals(ctx, tx, userID, d) }},
		{"diary", func() error { return importDiary(ctx, tx, userID, d) }},
		{"tz", func() error { return importTZ(ctx, tx, d) }},
		{"settings", func() error { return importSettings(ctx, tx, d) }},
	}
	for _, st := range steps {
		if err := st.fn(); err != nil {
			return fmt.Errorf("import %s: %w", st.name, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit import: %w", err)
	}
	return nil
}

func importMedications(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, m := range d.Medications.Items {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO medications
			  (id, name, dosage, schedule, archived, created_at, start_date, end_date,
			   rxcui, normalized_name, inventory_count, supplement, tz_shift_policy)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			m.ID, m.Name, m.Dosage, m.Schedule, m.Archived, m.CreatedAt,
			nullTime(m.StartDate), nullTime(m.EndDate), m.RxCUI, m.NormalizedName,
			nullInt(m.InventoryCount), m.Supplement, m.TZShiftPolicy); err != nil {
			return err
		}
	}
	for _, in := range d.Medications.Intakes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO intake_log
			  (medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix, source)
			VALUES (?,?,?,?,?,?,?)`,
			in.MedicationID, userID, in.ScheduledAt.UTC().Unix(),
			nullUnix(in.TakenAt), in.Status, nullUnix(in.SnoozedUntil), in.Source); err != nil {
			return err
		}
	}
	for _, rs := range d.Medications.Restocks {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO medication_restocks (medication_id, quantity, note, restocked_at)
			VALUES (?,?,?,?)`,
			rs.MedicationID, rs.Quantity, rs.Note, rs.RestockedAt); err != nil {
			return err
		}
	}
	return nil
}

func importBP(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, b := range d.BP.Readings {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO blood_pressure_readings
			  (user_id, measured_at, systolic, diastolic, pulse, site, position, ignore_calc, notes, tag)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			userID, b.MeasuredAt, b.Systolic, b.Diastolic, nullInt(b.Pulse),
			b.Site, b.Position, b.IgnoreCalc, b.Notes, b.Tag); err != nil {
			return err
		}
	}
	var sys, dia any
	if g := d.BP.Goal; g != nil {
		sys, dia = nullInt(g.TargetSystolic), nullInt(g.TargetDiastolic)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE settings SET bp_target_systolic = ?, bp_target_diastolic = ? WHERE id = 1`,
		sys, dia); err != nil {
		return err
	}
	return nil
}

func importWeight(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, wl := range d.Weight.Logs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO weight_logs (user_id, measured_at, weight, body_fat, muscle_mass, notes)
			VALUES (?,?,?,?,?,?)`,
			userID, wl.MeasuredAt, wl.Weight, nullFloat(wl.BodyFat), nullFloat(wl.MuscleMass), wl.Notes); err != nil {
			return err
		}
	}
	if g := d.Weight.Goal; g != nil {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
			VALUES (?,?,?,?,?)`,
			userID, g.SetAt.UTC().Unix(), g.TargetWeight, g.TargetDate, nullFloat(g.StartWeight)); err != nil {
			return err
		}
	}
	if d.Weight.UnitPref != nil {
		if _, err := tx.ExecContext(ctx,
			`UPDATE settings SET weight_unit_preference = ? WHERE id = 1`, *d.Weight.UnitPref); err != nil {
			return err
		}
	}
	return nil
}

func importFood(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, p := range d.Food.Products {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO food_products
			  (id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g,
			   usage_count, created_at, last_used_at, is_meal, total_weight_g)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			p.ID, userID, p.Name, nullStr(p.Barcode), p.Carbs100g, p.Protein100g, p.Fat100g,
			p.EnergyKcal100g, p.UsageCount, p.CreatedAt, p.LastUsedAt, p.IsMeal, p.TotalWeightG); err != nil {
			return err
		}
	}
	for _, fl := range d.Food.Logs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO food_log (user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id)
			VALUES (?,?,?,?,?,?,?,?,?)`,
			userID, fl.EatenAt, fl.Weight, fl.Carbs, fl.Protein, fl.Fat, fl.Calories, fl.Name,
			nullInt64(fl.ProductID)); err != nil {
			return err
		}
	}
	return nil
}

func importWorkouts(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	w := &d.Workouts
	for _, g := range w.Groups {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_groups
			  (id, name, description, is_rotating, user_id, days_of_week, scheduled_time,
			   notification_advance_minutes, active, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
			g.ID, g.Name, g.Description, g.IsRotating, userID, g.DaysOfWeek, g.ScheduledTime,
			g.NotificationAdvanceMinutes, g.Active, g.CreatedAt, g.UpdatedAt); err != nil {
			return err
		}
	}
	for _, v := range w.Variants {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_variants (id, group_id, name, rotation_order, description, created_at)
			VALUES (?,?,?,?,?,?)`,
			v.ID, v.GroupID, v.Name, nullInt(v.RotationOrder), v.Description, v.CreatedAt); err != nil {
			return err
		}
	}
	for _, e := range w.Exercises {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_exercises
			  (id, variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
			VALUES (?,?,?,?,?,?,?,?)`,
			e.ID, e.VariantID, e.ExerciseName, e.TargetSets, e.TargetRepsMin,
			nullInt(e.TargetRepsMax), nullFloat(e.TargetWeightKg), e.OrderIndex); err != nil {
			return err
		}
	}
	for _, l := range w.Library {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO exercise_library
			  (id, user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg, notes, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			l.ID, userID, l.Name, l.DefaultSets, l.DefaultRepsMin, nullInt(l.DefaultRepsMax),
			nullFloat(l.DefaultWeightKg), l.Notes, l.CreatedAt, l.UpdatedAt); err != nil {
			return err
		}
	}
	for _, rot := range w.Rotations {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_rotation_state (group_id, current_variant_id, last_session_date, updated_at)
			VALUES (?,?,?,?)`,
			rot.GroupID, rot.CurrentVariantID, nullTime(rot.LastSessionDate), rot.UpdatedAt); err != nil {
			return err
		}
	}
	for _, ses := range w.Sessions {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_sessions
			  (id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status,
			   started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			ses.ID, ses.GroupID, ses.VariantID, userID, ses.ScheduledDate, ses.ScheduledTime, ses.Status,
			nullTime(ses.StartedAt), nullTime(ses.CompletedAt), nullTime(ses.SnoozedUntil),
			ses.SnoozeCount, nullInt(ses.NotificationMessageID), ses.Notes); err != nil {
			return err
		}
	}
	for _, el := range w.ExerciseLogs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_exercise_logs
			  (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at, source)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			el.SessionID, el.ExerciseID, el.ExerciseName, nullInt(el.SetsCompleted),
			nullInt(el.RepsCompleted), nullFloat(el.WeightKg), el.Status, el.Notes, el.LoggedAt, el.Source); err != nil {
			return err
		}
	}
	for _, mb := range w.MiBand {
		res, err := tx.ExecContext(ctx, `
			INSERT INTO miband_workouts
			  (user_id, source_start_ms, source_end_ms, activity_type, activity_name, duration_sec,
			   distance_m, steps, calories, heart_rate_avg, spo2_avg, pause_ms, tz_offset, source)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			userID, mb.SourceStartMs, mb.SourceEndMs, mb.ActivityType, mb.ActivityName, mb.DurationSec,
			mb.DistanceM, mb.Steps, mb.Calories, mb.HeartRateAvg, mb.SpO2Avg, mb.PauseMs, mb.TzOffset, mb.Source)
		if err != nil {
			return err
		}
		workoutID, err := res.LastInsertId()
		if err != nil {
			return err
		}
		for _, pt := range mb.GPS {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO miband_gps_tracks (workout_id, point_index, ts_ms, latitude, longitude, altitude, is_pause)
				VALUES (?,?,?,?,?,?,?)`,
				workoutID, pt.PointIndex, pt.TsMs, pt.Latitude, pt.Longitude, pt.Altitude, pt.IsPause); err != nil {
				return err
			}
		}
	}
	return nil
}

func importVitals(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, sl := range d.Vitals.Sleep {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO sleep_logs
			  (user_id, start_time, end_time, timezone_offset, day, light_minutes, deep_minutes,
			   rem_minutes, awake_minutes, total_minutes, turn_over_count, heart_rate_avg, spo2_avg, user_modified, notes)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			userID, sl.StartTime, sl.EndTime, sl.TimezoneOffset, sl.Day, nullInt(sl.LightMinutes),
			nullInt(sl.DeepMinutes), nullInt(sl.REMMinutes), nullInt(sl.AwakeMinutes), nullInt(sl.TotalMinutes),
			nullInt(sl.TurnOverCount), nullInt(sl.HeartRateAvg), nullInt(sl.SpO2Avg), sl.UserModified, sl.Notes); err != nil {
			return err
		}
	}
	for _, ds := range d.Vitals.DayStats {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO day_stats (user_id, day, steps, calories, distance) VALUES (?,?,?,?,?)`,
			userID, ds.Day, ds.Steps, ds.Calories, ds.Distance); err != nil {
			return err
		}
	}
	// vitals.type is not part of the wire shape (never read back by the list
	// methods); store 0 as a neutral placeholder.
	for _, h := range d.Vitals.Heart {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_heart (user_id, date_time, tz_offset, value, type) VALUES (?,?,?,?,0)`,
			userID, h.DateTime.UnixMilli(), h.TzOffset, h.Value); err != nil {
			return err
		}
	}
	for _, sp := range d.Vitals.SpO2 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_spo2 (user_id, date_time, tz_offset, value, type) VALUES (?,?,?,?,0)`,
			userID, sp.DateTime.UnixMilli(), sp.TzOffset, sp.Value); err != nil {
			return err
		}
	}
	for _, st := range d.Vitals.Stress {
		var info any
		if st.Info != "" {
			info = st.Info
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_stress (user_id, date_time, tz_offset, value, type, info) VALUES (?,?,?,?,0,?)`,
			userID, st.DateTime.UnixMilli(), st.TzOffset, st.Value, info); err != nil {
			return err
		}
	}
	return nil
}

func importDiary(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, n := range d.Diary.Notes {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO diary_notes (user_id, content, created_at, tag) VALUES (?,?,?,?)`,
			userID, n.Content, n.CreatedAt, nullStr(n.Tag)); err != nil {
			return err
		}
	}
	return nil
}

func importTZ(ctx context.Context, tx *sql.Tx, d *VaultData) error {
	for _, c := range d.TZ.History {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO timezone_history (timezone, recorded_at) VALUES (?,?)`,
			c.Timezone, c.ChangedAt); err != nil {
			return err
		}
	}
	// Cloud-native accounts carry `current` with an empty `history` (cloud stores
	// the timezone on the settings singleton, not in timezone_history). Bot
	// GetCurrent() reads only from timezone_history, so without this the imported
	// timezone would silently drop to "". Insert a row (stamped latest) when the
	// current timezone isn't already the newest history entry.
	if d.TZ.Current != nil && *d.TZ.Current != "" {
		latest := ""
		if n := len(d.TZ.History); n > 0 {
			latest = d.TZ.History[n-1].Timezone
		}
		if latest != *d.TZ.Current {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO timezone_history (timezone, recorded_at) VALUES (?,?)`,
				*d.TZ.Current, time.Now().UTC()); err != nil {
				return err
			}
		}
	}
	if p := d.TZ.TransitionPlan; p != nil {
		steps := make([]tzreschedule.TransitionStep, 0, len(p.Steps))
		for _, s := range p.Steps {
			steps = append(steps, tzreschedule.TransitionStep{
				MedicationID: s.MedicationID,
				MedName:      s.MedName,
				StepNumber:   s.StepNumber,
				TotalSteps:   s.TotalSteps,
				ScheduledAt:  s.ScheduledAt,
				Note:         s.Note,
			})
		}
		stepsJSON, err := json.Marshal(steps)
		if err != nil {
			return fmt.Errorf("marshal tz steps: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO tz_transition_plans (old_tz, new_tz, created_at_unix, status, steps_json, approved_at_unix)
			VALUES (?,?,?,?,?,?)`,
			p.OldTZ, p.NewTZ, p.CreatedAt.UTC().Unix(), p.Status, string(stepsJSON),
			nullUnix(p.ApprovedAt)); err != nil {
			return err
		}
	}
	return nil
}

func importSettings(ctx context.Context, tx *sql.Tx, d *VaultData) error {
	s := &d.Settings

	var tabOrder any
	if len(s.TabOrder) > 0 {
		b, err := json.Marshal(s.TabOrder)
		if err != nil {
			return fmt.Errorf("marshal tab order: %w", err)
		}
		tabOrder = string(b)
	}

	var ftCal, ftCarbs, ftProt, ftFat int
	if t := s.FoodTargets; t != nil {
		ftCal, ftCarbs, ftProt, ftFat = t.Calories, t.Carbs, t.Protein, t.Fat
	}

	oa, fi, el := s.Integrations.OpenAI, s.Integrations.Food, s.Integrations.ElevenLabs
	f := s.Features

	_, err := tx.ExecContext(ctx, `
		UPDATE settings SET
		  dismissed_tz_suggestion = ?,
		  food_intake_enabled = ?, blood_pressure_enabled = ?, weight_enabled = ?,
		  medication_enabled = ?, workout_enabled = ?, health_enabled = ?,
		  gamification_enabled = ?, weekly_digest_enabled = ?,
		  tab_order = ?,
		  food_target_calories = ?, food_target_carbs = ?, food_target_protein = ?, food_target_fat = ?,
		  openai_api_key = ?, openai_url = ?, openai_model = ?,
		  openai_vision_api_key = ?, openai_vision_url = ?, openai_vision_model = ?,
		  food_api_key = ?, food_url = ?, food_domain = ?,
		  elevenlabs_api_key = ?, elevenlabs_agent_id = ?
		WHERE id = 1`,
		s.DismissedTZSuggestion,
		f.Food, f.BP, f.Weight, f.Medication, f.Workout, f.Health, f.Gamification, f.WeeklyDigest,
		tabOrder,
		ftCal, ftCarbs, ftProt, ftFat,
		oa.APIKey, oa.URL, oa.Model, oa.VisionAPIKey, oa.VisionURL, oa.VisionModel,
		fi.APIKey, fi.URL, fi.Domain,
		el.APIKey, el.AgentID)
	return err
}

// --- nullable SQL arg helpers ---

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func nullUnix(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Unix()
}

func nullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
