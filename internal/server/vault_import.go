package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/server/vaultformat"
)

type importRequest struct {
	Mode string                 `json:"mode"`
	Data *vaultformat.VaultFile `json:"data"`
}

func (s *Server) handleImportVault(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u, ok := r.Context().Value(UserCtxKey).(*TelegramUser)
	if !ok || u == nil || u.ID == 0 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	userID := u.ID

	var req importRequest
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid json: %v", err), http.StatusBadRequest)
		return
	}

	if req.Mode != "replace" {
		http.Error(w, "import requires mode: replace", http.StatusBadRequest)
		return
	}

	if req.Data == nil || req.Data.Format != "medtracker-vault" || req.Data.Version != 1 {
		http.Error(w, "unknown or invalid vault format/version", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Wipe User data transactionally via seeddemo.WipeUser
	if err := seeddemo.WipeUser(ctx, s.store, userID); err != nil {
		http.Error(w, fmt.Sprintf("wipe failed: %v", err), http.StatusInternalServerError)
		return
	}

	if req.Data.Data == nil {
		w.WriteHeader(http.StatusOK)
		return
	}

	insertTx, err := s.store.DB().BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, "failed to start insert tx", http.StatusInternalServerError)
		return
	}
	defer func() { _ = insertTx.Rollback() }()

	// Import Medications
	if req.Data.Data.Medications != nil {
		for _, m := range req.Data.Data.Medications.Medications {
			policy := m.TZShiftPolicy
			if policy == "" {
				policy = "flexible"
			}
			_, err := insertTx.ExecContext(ctx, "INSERT INTO medications (id, name, dosage, schedule, start_date, end_date, rxcui, normalized_name, tz_shift_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				m.ID, m.Name, m.Dosage, m.Schedule, m.StartDate, m.EndDate, m.RxCUI, m.NormalizedName, policy)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert med: %v", err), http.StatusInternalServerError)
				return
			}
		}

		for _, idx := range req.Data.Data.Medications.Intakes {
			var takenUnix *int64
			if idx.TakenAt != nil {
				unix := idx.TakenAt.Unix()
				takenUnix = &unix
			}
			var snoozedUnix *int64
			if idx.SnoozedUntil != nil {
				unix := idx.SnoozedUntil.Unix()
				snoozedUnix = &unix
			}
			_, err := insertTx.ExecContext(ctx, "INSERT INTO intake_log (id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix, source, tz_plan_id, tz_step_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				idx.ID, idx.MedicationID, userID, idx.ScheduledAt.Unix(), takenUnix, idx.Status, snoozedUnix, idx.Source, idx.TZPlanID, idx.TZStepNumber)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert intake: %v", err), http.StatusInternalServerError)
				return
			}
		}

		for _, restock := range req.Data.Data.Medications.Restocks {
			_, err := insertTx.ExecContext(ctx, "INSERT INTO medication_restocks (id, medication_id, qty, note, created_at) VALUES (?, ?, ?, ?, ?)",
				restock.ID, restock.MedicationID, restock.Quantity, restock.Note, restock.RestockedAt)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert restock: %v", err), http.StatusInternalServerError)
				return
			}
		}
	}

	// Import BP
	if req.Data.Data.BP != nil {
		for _, b := range req.Data.Data.BP.Readings {
			_, err := insertTx.ExecContext(ctx, "INSERT INTO blood_pressure_readings (id, user_id, sys, dia, pulse, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				b.ID, userID, b.Systolic, b.Diastolic, b.Pulse, b.Notes, b.MeasuredAt)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert BP: %v", err), http.StatusInternalServerError)
				return
			}
		}
		if req.Data.Data.BP.Goal != nil {
			g := req.Data.Data.BP.Goal
			_, err := insertTx.ExecContext(ctx, "INSERT INTO bp_reminder_state (user_id, sys_target, dia_target) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET sys_target=excluded.sys_target, dia_target=excluded.dia_target",
				userID, g.TargetSystolic, g.TargetDiastolic)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert BP Goal: %v", err), http.StatusInternalServerError)
				return
			}
		}
	}

	// Import Weight
	if req.Data.Data.Weight != nil {
		for _, wl := range req.Data.Data.Weight.Logs {
			_, err := insertTx.ExecContext(ctx, "INSERT INTO weight_logs (id, user_id, weight_kg, note, recorded_at) VALUES (?, ?, ?, ?, ?)",
				wl.ID, userID, wl.Weight, wl.Notes, wl.MeasuredAt)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to insert weight: %v", err), http.StatusInternalServerError)
				return
			}
		}
		if req.Data.Data.Weight.UnitPref != "" {
			_, err := insertTx.ExecContext(ctx, "UPDATE settings SET weight_unit_preference = ? WHERE id = 1", req.Data.Data.Weight.UnitPref)
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to set weight unit: %v", err), http.StatusInternalServerError)
				return
			}
		}
	}

	// Import Settings & Misc
	if req.Data.Data.Settings != nil && req.Data.Data.Settings.MedReminderPref != nil {
		pref := req.Data.Data.Settings.MedReminderPref
		if pref != nil {
			_, err := insertTx.ExecContext(ctx, "UPDATE settings SET med_reminder_pref_json = ? WHERE id = 1",
				func() string { b, _ := json.Marshal(pref); return string(b) }())
			if err != nil {
				http.Error(w, fmt.Sprintf("failed to update settings: %v", err), http.StatusInternalServerError)
				return
			}
		}
	}

	if err := insertTx.Commit(); err != nil {
		http.Error(w, fmt.Sprintf("commit failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
