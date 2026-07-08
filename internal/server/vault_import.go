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
	// Data shadows Vault.Data (shallower field wins in encoding/json) so the
	// handler can tell "no data block at all" — a truncated body, a bad decrypt,
	// a foreign file — from "an empty one". Without it a header-only body wipes
	// the user and restores nothing, and the handler answers {"ok":true}.
	// Unmarshaled into Vault.Data explicitly once validated.
	Data json.RawMessage `json:"data"`
}

// handleVaultImport replaces the authed user's entire dataset with the posted
// canonical vault (see docs/vault-format.md). Additive to bot mode. It is
// all-or-nothing: parse + validate fully BEFORE touching the DB, then wipe and
// re-insert inside a single transaction so a mid-insert failure leaves the
// prior data intact.
func (s *Server) handleVaultImport(w http.ResponseWriter, r *http.Request) {
	// Demo mode bypasses auth, so this destructive whole-user replace would let
	// any anonymous visitor wipe the shared demo dataset. Block it.
	if s.demoMode {
		http.Error(w, "not available in demo mode", http.StatusForbidden)
		return
	}
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Same reason as handleVaultExport: uploading up to 64MB outruns
	// http.Server.ReadTimeout (15s), and the wipe-then-reinsert of every domain
	// outruns WriteTimeout (45s).
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(vaultIOTimeout))
	_ = rc.SetWriteDeadline(time.Now().Add(vaultIOTimeout))

	// Bound the body: the whole vault is materialized into structs in memory, so
	// an unbounded POST is a memory-DoS. Generous cap (vaults can be large) but
	// finite — every other JSON handler here uses http.MaxBytesReader.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)

	var req vaultImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid JSON: %v", err), http.StatusBadRequest)
		return
	}
	if errs := validateVault(&req); len(errs) > 0 {
		writeVaultErrors(w, errs)
		return
	}
	if err := json.Unmarshal(req.Data, &req.Vault.Data); err != nil {
		http.Error(w, fmt.Sprintf("invalid data block: %v", err), http.StatusBadRequest)
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
	if len(req.Data) == 0 || string(req.Data) == "null" {
		errs = append(errs, "missing \"data\" block — refusing to wipe and restore nothing")
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
		// tz first: intake_log.tz_plan_id points at tz_transition_plans.
		{"tz", func() error { return importTZ(ctx, tx, d) }},
		{"medications", func() error { return importMedications(ctx, tx, userID, d) }},
		{"bp", func() error { return importBP(ctx, tx, userID, d) }},
		{"weight", func() error { return importWeight(ctx, tx, userID, d) }},
		{"food", func() error { return importFood(ctx, tx, userID, d) }},
		{"workouts", func() error { return importWorkouts(ctx, tx, userID, d) }},
		{"vitals", func() error { return importVitals(ctx, tx, userID, d) }},
		{"diary", func() error { return importDiary(ctx, tx, userID, d) }},
		{"settings", func() error { return importSettings(ctx, tx, d) }},
		{"reminder_state", func() error { return importReminderState(ctx, tx, userID, d) }},
		{"gamification", func() error { return importGamification(ctx, tx, userID, d) }},
		{"api_tokens", func() error { return importAPITokens(ctx, tx, d) }},
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
			m.ID, m.Name, m.Dosage, m.Schedule, m.Archived, m.CreatedAt.UTC(),
			nullDate(m.StartDate), nullDate(m.EndDate), m.RxCUI, m.NormalizedName,
			nullInt(m.InventoryCount), m.Supplement, m.TZShiftPolicy); err != nil {
			return err
		}
	}
	for _, in := range d.Medications.Intakes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO intake_log
			  (medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix,
			   source, tz_plan_id, tz_step_number)
			VALUES (?,?,?,?,?,?,?,?,?)`,
			in.MedicationID, userID, in.ScheduledAt.UTC().Unix(),
			nullUnix(in.TakenAt), in.Status, nullUnix(in.SnoozedUntil), in.Source,
			nullInt64(in.TZPlanID), nullInt64(in.TZStepNumber)); err != nil {
			return err
		}
	}
	for _, rs := range d.Medications.Restocks {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO medication_restocks (medication_id, quantity, note, restocked_at)
			VALUES (?,?,?,?)`,
			rs.MedicationID, rs.Quantity, rs.Note, rs.RestockedAt.UTC()); err != nil {
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
			userID, b.MeasuredAt.UTC(), b.Systolic, b.Diastolic, nullInt(b.Pulse),
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
			userID, wl.MeasuredAt.UTC(), wl.Weight, nullFloat(wl.BodyFat), nullFloat(wl.MuscleMass), wl.Notes); err != nil {
			return err
		}
	}
	// Mirror the legacy singleton settings.weight_goal{,_date} columns, which
	// weight.SetGoal dual-writes. GetGoal falls back to them when weight_goals
	// is empty, so a replace-import with no goal must clear them (as importBP
	// does for bp_target_*) — otherwise a pre-import goal resurrects.
	var wGoal, wGoalDate any
	var latest *VaultWeightGoal
	for i := range d.Weight.Goals {
		g := &d.Weight.Goals[i]
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
			VALUES (?,?,?,?,?)`,
			userID, g.SetAt.UTC().Unix(), g.TargetWeight, g.TargetDate, nullFloat(g.StartWeight)); err != nil {
			return err
		}
		if latest == nil || !g.SetAt.Before(latest.SetAt) {
			latest = g
		}
	}
	if latest != nil {
		wGoal, wGoalDate = latest.TargetWeight, latest.TargetDate
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1`,
		wGoal, wGoalDate); err != nil {
		return err
	}
	// Always written (like weight_goal above): an absent unit_pref means the
	// source had no preference, so the destination must fall back to the column
	// default rather than keep its own. The column is NOT NULL CHECK IN
	// ('kg','lb'), hence COALESCE instead of a bare NULL.
	if _, err := tx.ExecContext(ctx,
		`UPDATE settings SET weight_unit_preference = COALESCE(?, 'kg') WHERE id = 1`,
		nullStr(d.Weight.UnitPref)); err != nil {
		return err
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
			p.EnergyKcal100g, p.UsageCount, p.CreatedAt.UTC(), p.LastUsedAt.UTC(), p.IsMeal, p.TotalWeightG); err != nil {
			return err
		}
	}
	for _, fl := range d.Food.Logs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO food_log (user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id)
			VALUES (?,?,?,?,?,?,?,?,?)`,
			userID, fl.EatenAt.UTC(), fl.Weight, fl.Carbs, fl.Protein, fl.Fat, fl.Calories, fl.Name,
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
			g.NotificationAdvanceMinutes, g.Active, g.CreatedAt.UTC(), g.UpdatedAt.UTC()); err != nil {
			return err
		}
	}
	for _, v := range w.Variants {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_variants (id, group_id, name, rotation_order, description, created_at)
			VALUES (?,?,?,?,?,?)`,
			v.ID, v.GroupID, v.Name, nullInt(v.RotationOrder), v.Description, v.CreatedAt.UTC()); err != nil {
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
			nullFloat(l.DefaultWeightKg), l.Notes, l.CreatedAt.UTC(), l.UpdatedAt.UTC()); err != nil {
			return err
		}
	}
	for _, rot := range w.Rotations {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_rotation_state (group_id, current_variant_id, last_session_date, updated_at)
			VALUES (?,?,?,?)`,
			rot.GroupID, rot.CurrentVariantID, nullDate(rot.LastSessionDate), rot.UpdatedAt.UTC()); err != nil {
			return err
		}
	}
	for _, ses := range w.Sessions {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workout_sessions
			  (id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status,
			   started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			ses.ID, ses.GroupID, ses.VariantID, userID, utcDate(ses.ScheduledDate), ses.ScheduledTime, ses.Status,
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
			nullInt(el.RepsCompleted), nullFloat(el.WeightKg), el.Status, el.Notes, el.LoggedAt.UTC(), el.Source); err != nil {
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
			userID, sl.StartTime.UTC(), sl.EndTime.UTC(), sl.TimezoneOffset, sl.Day, nullInt(sl.LightMinutes),
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
	for _, h := range d.Vitals.Heart {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_heart (user_id, date_time, tz_offset, value, type) VALUES (?,?,?,?,?)`,
			userID, h.DateTime.UnixMilli(), h.TzOffset, h.Value, h.Type); err != nil {
			return err
		}
	}
	for _, sp := range d.Vitals.SpO2 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_spo2 (user_id, date_time, tz_offset, value, type) VALUES (?,?,?,?,?)`,
			userID, sp.DateTime.UnixMilli(), sp.TzOffset, sp.Value, sp.Type); err != nil {
			return err
		}
	}
	for _, st := range d.Vitals.Stress {
		var info any
		if st.Info != "" {
			info = st.Info
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vitals_stress (user_id, date_time, tz_offset, value, type, info) VALUES (?,?,?,?,?,?)`,
			userID, st.DateTime.UnixMilli(), st.TzOffset, st.Value, st.Type, info); err != nil {
			return err
		}
	}
	return nil
}

func importDiary(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	for _, n := range d.Diary.Notes {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO diary_notes (user_id, content, created_at, tag) VALUES (?,?,?,?)`,
			userID, n.Content, n.CreatedAt.UTC(), nullStr(n.Tag)); err != nil {
			return err
		}
	}
	return nil
}

func importTZ(ctx context.Context, tx *sql.Tx, d *VaultData) error {
	for _, c := range d.TZ.History {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO timezone_history (timezone, recorded_at) VALUES (?,?)`,
			c.Timezone, c.ChangedAt.UTC()); err != nil {
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
	for _, p := range d.TZ.TransitionPlans {
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
		// Preserve the plan id (NULL id => autoincrement) so intake_log.tz_plan_id
		// still resolves; cloud-native vaults carry no id and get a fresh one.
		var planID any
		if p.ID != 0 {
			planID = p.ID
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO tz_transition_plans
			  (id, old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash,
			   approved_at_unix, notified_at_unix, user_action)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
			planID, p.OldTZ, p.NewTZ, p.CreatedAt.UTC().Unix(), p.Status, string(stepsJSON),
			p.InputsJSON, p.PlanHash,
			nullUnix(p.ApprovedAt), nullUnix(p.NotifiedAt), p.UserAction); err != nil {
			return err
		}
	}
	return nil
}

// importReminderState restores the two scheduler-owned reminder rows. Only the
// user-set fields are carried (see exportReminderState); the transient
// last_notification_sent_at / notification_message_id columns stay unset so a
// restore never resurrects a stale Telegram message id. The rows were deleted by
// the wipe, so this is a plain INSERT.
//
// A vault may legitimately omit either block (a cloud export only carries the
// reminder prefs the user actually touched). The row must exist afterwards
// regardless: the scheduler enumerates these tables directly
// (bp.ListUsersForReminders / weight.ListReminderStates) and never self-heals,
// so a missing row silences reminders until the user happens to open Settings.
// Absent block => the migration's default row, i.e. the fresh-install state.
func importReminderState(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	write := func(table string, st *VaultReminderState, defaultHour int) error {
		enabled, hour := true, defaultHour
		var snoozed, dontRemind any
		if st != nil {
			enabled, hour = st.Enabled, st.PreferredReminderHour
			snoozed, dontRemind = nullTime(st.SnoozedUntil), nullTime(st.DontRemindUntil)
		}
		// #nosec G202 -- table is one of two in-package literals, not user input.
		_, err := tx.ExecContext(ctx, `
			INSERT INTO `+table+`
			  (user_id, enabled, preferred_reminder_hour, snoozed_until, dont_remind_until)
			VALUES (?,?,?,?,?)`,
			userID, enabled, hour, snoozed, dontRemind)
		if err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
		return nil
	}
	// Defaults mirror migrations 015 / 016.
	if err := write("bp_reminder_state", d.Settings.BPReminder, 20); err != nil {
		return err
	}
	return write("weight_reminder_state", d.Settings.WeightReminder, 9)
}

func importGamification(ctx context.Context, tx *sql.Tx, userID int64, d *VaultData) error {
	g := &d.Gamification
	for _, t := range g.Targets {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO gamification_targets (user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix)
			VALUES (?,?,?,?,?,?,?)`,
			userID, t.MetricKey, nullFloat(t.LowVal), nullFloat(t.HighVal), nullFloat(t.Falloff),
			nullStr(t.Mode), t.UpdatedAt.UTC().Unix()); err != nil {
			return fmt.Errorf("targets: %w", err)
		}
	}
	for _, e := range g.Ledger {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO gamification_ledger
			  (user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix)
			VALUES (?,?,?,?,?,?,?,?)`,
			userID, e.Day.UTC().Unix(), e.Ring, e.SourceMetric, e.Kind, e.HP,
			nullStr(e.Detail), e.CreatedAt.UTC().Unix()); err != nil {
			return fmt.Errorf("ledger: %w", err)
		}
	}
	if st := g.State; st != nil {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO gamification_state
			  (user_id, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier,
			   last_scored_day_unix, backfilled_at_unix, updated_at_unix)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			userID, st.LifetimeHP, st.Level, st.CurrentStreak, st.LongestStreak, st.Freezes,
			st.InsightTier, nullUnix(st.LastScoredDay), nullUnix(st.BackfilledAt),
			st.UpdatedAt.UTC().Unix()); err != nil {
			return fmt.Errorf("state: %w", err)
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

	f := s.Features

	// Feature flags are COALESCEd against the existing row so an absent flag
	// (nil pointer → NULL) preserves the current enabled state instead of
	// disabling the section. See VaultFeatures in vault_format.go.
	_, err := tx.ExecContext(ctx, `
		UPDATE settings SET
		  dismissed_tz_suggestion = ?,
		  food_intake_enabled = COALESCE(?, food_intake_enabled),
		  blood_pressure_enabled = COALESCE(?, blood_pressure_enabled),
		  weight_enabled = COALESCE(?, weight_enabled),
		  medication_enabled = COALESCE(?, medication_enabled),
		  workout_enabled = COALESCE(?, workout_enabled),
		  health_enabled = COALESCE(?, health_enabled),
		  gamification_enabled = COALESCE(?, gamification_enabled),
		  weekly_digest_enabled = COALESCE(?, weekly_digest_enabled),
		  tab_order = ?,
		  food_target_calories = ?, food_target_carbs = ?, food_target_protein = ?, food_target_fat = ?
		WHERE id = 1`,
		s.DismissedTZSuggestion,
		nullBool(f.Food), nullBool(f.BP), nullBool(f.Weight), nullBool(f.Medication),
		nullBool(f.Workout), nullBool(f.Health), nullBool(f.Gamification), nullBool(f.WeeklyDigest),
		tabOrder,
		ftCal, ftCarbs, ftProt, ftFat)
	if err != nil {
		return err
	}

	// Provider keys are the secret half: an absent block (include_secrets=0
	// export) leaves the destination's keys alone, a present one replaces them.
	// This is the vault's only non-replace import path — see docs/vault-format.md.
	ig := s.Integrations
	if ig == nil {
		return nil
	}
	oa, fi, el := ig.OpenAI, ig.Food, ig.ElevenLabs
	_, err = tx.ExecContext(ctx, `
		UPDATE settings SET
		  openai_api_key = ?, openai_url = ?, openai_model = ?,
		  openai_vision_api_key = ?, openai_vision_url = ?, openai_vision_model = ?,
		  food_api_key = ?, food_url = ?, food_domain = ?,
		  elevenlabs_api_key = ?, elevenlabs_agent_id = ?
		WHERE id = 1`,
		oa.APIKey, oa.URL, oa.Model, oa.VisionAPIKey, oa.VisionURL, oa.VisionModel,
		fi.APIKey, fi.URL, fi.Domain,
		el.APIKey, el.AgentID)
	return err
}

// importAPITokens mirrors the integrations rule: an absent api_tokens block
// (include_secrets=0) leaves the destination's tokens minted and working; a
// present block replaces them wholesale. api_tokens is deliberately NOT in
// WipeUserTx — the wipe runs before this step, and a secrets-free vault must
// not silently de-authorize the target's MCP clients.
func importAPITokens(ctx context.Context, tx *sql.Tx, d *VaultData) error {
	if d.APITokens == nil {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM api_tokens`); err != nil {
		return err
	}
	for _, t := range *d.APITokens {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO api_tokens (name, token_hash, created_at, last_used_at) VALUES (?,?,?,?)`,
			t.Name, t.TokenHash, t.CreatedAt.UTC(), nullTime(t.LastUsedAt)); err != nil {
			return err
		}
	}
	return nil
}

// --- nullable SQL arg helpers ---

func nullBool(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

// nullTime / utcDate normalize a bound timestamp. A vault carries
// offset-bearing RFC 3339 timestamps ("…+02:00"), and the modernc.org/sqlite
// driver writes a non-UTC time.Time in Go's time.Time.String() form
// ("2026-07-07 12:00:00 +0200 +0200") — a text form its own reader cannot
// parse, so every later scan into time.Time / sql.NullTime hard-errors on that
// row. A UTC time.Time is written as RFC 3339 ("…Z") and round-trips. Same
// instant either way: this is a storage normalization, not a change of meaning.
// So every bound time.Time goes through .UTC() (or utcDate, below).
func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC()
}

// utcDate keeps the *calendar date* the vault recorded (in its own offset)
// rather than the instant: workout_sessions.scheduled_date is a DATE column,
// and plain .UTC() would move 2026-07-07T00:00:00+02:00 back to 2026-07-06.
func utcDate(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func nullDate(t *time.Time) any {
	if t == nil {
		return nil
	}
	return utcDate(*t)
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
