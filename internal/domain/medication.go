package domain

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrNotPending is returned when an intake is not in PENDING state.
var ErrNotPending = errors.New("intake is not pending")

// ErrNotTaken is returned when an intake is not in TAKEN state.
var ErrNotTaken = errors.New("intake is not taken")

// ErrNotFutureIntake is returned when an intake cannot be deleted because it is
// not a future PENDING dose (already taken/skipped, or scheduled in the past).
var ErrNotFutureIntake = errors.New("intake is not a future pending dose")

// MedicationStore is the narrow store interface required by MedicationService.
type MedicationStore interface {
	GetIntake(id int64) (*store.IntakeLog, error)
	GetMedication(id int64) (*store.Medication, error)
	GetIntakeReminders(intakeID int64) ([]int, error)
	GetBatchIntakeReminders(intakeIDs []int64) (map[int64][]int, error)
	GetPendingIntakes() ([]store.IntakeLog, error)
	GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	ConfirmIntake(id int64, takenAt time.Time) error
	ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error)
	SkipIntake(id int64) error
	SnoozeIntake(id int64, snoozeUntil time.Time) error
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error)
	DecrementInventory(medID int64, qty int) error
	UpdateIntake(id int64, takenAt time.Time, status string) error
	DeleteIntake(id int64) error
}

// MedicationService is the public interface for medication business logic.
// It contains only domain decisions; the caller (bot layer) handles all
// Telegram message sending and deletion.
type MedicationService interface {
	// ConfirmIntakeWithCleanup validates the intake is PENDING, collects reminder
	// message IDs, confirms the intake, and decrements inventory.
	// Returns the reminder message IDs, whether the medication is a supplement,
	// the medication name and dosage (for display), and any error.
	ConfirmIntakeWithCleanup(intakeID int64, takenAt time.Time) (reminderMsgIDs []int, isSupplement bool, medName string, medDosage string, err error)

	// SkipIntake validates the intake is PENDING,
	// collects reminder message IDs, and marks the intake as skipped.
	// Returns reminder message IDs, medication name and dosage (for display), and any error.
	SkipIntake(intakeID int64) (reminderMsgIDs []int, medName string, medDosage string, err error)

	// LogMedicationNow creates a new intake and immediately confirms it.
	// Used for ad-hoc "log now" without a pre-existing pending record.
	LogMedicationNow(userID, medID int64) error

	// LogMedicationAt creates a new intake with status='TAKEN' at the given time.
	// Used for logging past intakes from the web UI. Returns the new intake ID.
	LogMedicationAt(userID, medID int64, takenAt time.Time) (int64, error)

	// ConfirmScheduleWithCleanup batch-confirms all pending intakes for a scheduled
	// time slot and collects all reminder message IDs across those intakes.
	// Returns the reminder message IDs so the caller can delete them, plus the
	// number of intakes actually flipped to TAKEN by this call (so the caller
	// can distinguish "nothing matched" — e.g. the slot was already confirmed
	// or the lookup landed in a different timezone — from a real success).
	ConfirmScheduleWithCleanup(userID int64, scheduledAt time.Time) (reminderMsgIDs []int, confirmedCount int, err error)

	// ConfirmMedicationByMedID finds the first pending intake for a medication and confirms it.
	// Used by the legacy confirm: callback which only carries a medication ID, not an intake ID.
	// Returns ErrNotPending if no pending intake exists for the medication.
	ConfirmMedicationByMedID(medID int64, takenAt time.Time) (reminderMsgIDs []int, isSupplement bool, medName string, medDosage string, err error)

	// SilenceIntake snoozes a pending intake for 24 hours and returns reminder message IDs
	// so the caller can delete the current reminder message.
	SilenceIntake(intakeID int64) (reminderMsgIDs []int, err error)

	// CancelIntake reverts a TAKEN intake back to PENDING and increments inventory.
	// Returns the medication name and dosage for display, and any error.
	CancelIntake(intakeID int64) (medName string, medDosage string, err error)

	// DeleteFutureIntake removes a PENDING intake whose scheduled_at is in the
	// future. The scheduler will recreate it on the regular schedule. Returns
	// ErrNotFutureIntake if the intake is not PENDING or is not in the future,
	// the reminder message IDs that should be cleaned up, and the medication
	// name/dosage for display.
	DeleteFutureIntake(intakeID int64) (reminderMsgIDs []int, medName string, medDosage string, err error)
}

type medicationService struct {
	store MedicationStore
}

// NewMedicationService creates a new MedicationService backed by the given store.
func NewMedicationService(s MedicationStore) MedicationService {
	return &medicationService{store: s}
}

func (s *medicationService) ConfirmIntakeWithCleanup(intakeID int64, takenAt time.Time) ([]int, bool, string, string, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, false, "", "", fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, false, "", "", ErrNotPending
	}

	// Fetch medication for supplement status and display name/dosage (best-effort).
	isSupplement := false
	medName, medDosage := "", ""
	if med, err := s.store.GetMedication(intake.MedicationID); err != nil {
		slog.Error("GetMedication for intake failed", "intakeID", intakeID, "error", err)
	} else if med != nil {
		isSupplement = med.Supplement
		medName = med.Name
		medDosage = med.Dosage
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		slog.Error("GetIntakeReminders failed", "intakeID", intakeID, "error", err)
	}

	if err := s.store.ConfirmIntake(intakeID, takenAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, "", "", ErrNotPending
		}
		return nil, false, "", "", fmt.Errorf("confirm intake %d: %w", intakeID, err)
	}

	// Inventory decrement is best-effort; a confirmed intake is the source of truth.
	if err := s.store.DecrementInventory(intake.MedicationID, 1); err != nil {
		slog.Error("DecrementInventory failed", "intakeID", intakeID, "error", err)
	}

	return reminders, isSupplement, medName, medDosage, nil
}

func (s *medicationService) SkipIntake(intakeID int64) ([]int, string, string, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, "", "", fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, "", "", ErrNotPending
	}

	// Fetch medication name/dosage for display (best-effort).
	medName, medDosage := "", ""
	if med, err := s.store.GetMedication(intake.MedicationID); err != nil {
		slog.Error("GetMedication for intake failed", "intakeID", intakeID, "error", err)
	} else if med != nil {
		medName = med.Name
		medDosage = med.Dosage
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		slog.Error("GetIntakeReminders failed", "intakeID", intakeID, "error", err)
	}

	if err := s.store.SkipIntake(intakeID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", "", ErrNotPending
		}
		return nil, "", "", fmt.Errorf("skip intake %d: %w", intakeID, err)
	}

	return reminders, medName, medDosage, nil
}

func (s *medicationService) LogMedicationNow(userID, medID int64) error {
	_, err := s.LogMedicationAt(userID, medID, time.Now())
	return err
}

func (s *medicationService) LogMedicationAt(userID, medID int64, takenAt time.Time) (int64, error) {
	// CreateManualIntake inserts directly with status='TAKEN', avoiding a separate ConfirmIntake
	// call that could leave a dangling PENDING record on partial failure.
	id, err := s.store.CreateManualIntake(medID, userID, takenAt)
	if err != nil {
		return 0, fmt.Errorf("create manual intake for med %d: %w", medID, err)
	}
	// Inventory decrement is best-effort.
	if err := s.store.DecrementInventory(medID, 1); err != nil {
		slog.Error("DecrementInventory failed", "medID", medID, "error", err)
	}
	return id, nil
}

func (s *medicationService) ConfirmScheduleWithCleanup(userID int64, scheduledAt time.Time) ([]int, int, error) {
	pending, err := s.store.GetPendingIntakesBySchedule(userID, scheduledAt)
	if err != nil {
		return nil, 0, fmt.Errorf("get pending intakes by schedule: %w", err)
	}

	var allReminders []int
	for _, p := range pending {
		reminders, err := s.store.GetIntakeReminders(p.ID)
		if err != nil {
			slog.Error("GetIntakeReminders failed", "intakeID", p.ID, "error", err)
		}
		allReminders = append(allReminders, reminders...)
	}

	confirmedIDs, err := s.store.ConfirmIntakesBySchedule(userID, scheduledAt, time.Now())
	if err != nil {
		return nil, 0, fmt.Errorf("confirm intakes by schedule: %w", err)
	}

	// Only decrement inventory for intakes that were actually confirmed by this call
	confirmedIDSet := make(map[int64]bool)
	for _, id := range confirmedIDs {
		confirmedIDSet[id] = true
	}

	for _, p := range pending {
		if confirmedIDSet[p.ID] {
			if err := s.store.DecrementInventory(p.MedicationID, 1); err != nil {
				slog.Error("DecrementInventory failed", "intakeID", p.ID, "error", err)
			}
		}
	}

	return allReminders, len(confirmedIDs), nil
}

func (s *medicationService) ConfirmMedicationByMedID(medID int64, takenAt time.Time) ([]int, bool, string, string, error) {
	pending, err := s.store.GetPendingIntakes()
	if err != nil {
		return nil, false, "", "", fmt.Errorf("get pending intakes: %w", err)
	}

	// Find all pending intakes for this medication
	var matching []store.IntakeLog
	for _, p := range pending {
		if p.MedicationID == medID {
			matching = append(matching, p)
		}
	}

	if len(matching) == 0 {
		return nil, false, "", "", ErrNotPending
	}

	// Sort by ScheduledAt descending to confirm the most recent pending intake
	sort.Slice(matching, func(i, j int) bool {
		return matching[i].ScheduledAt.After(matching[j].ScheduledAt)
	})

	return s.ConfirmIntakeWithCleanup(matching[0].ID, takenAt)
}

func (s *medicationService) CancelIntake(intakeID int64) (string, string, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return "", "", fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "TAKEN" {
		return "", "", ErrNotTaken
	}

	// Fetch medication name/dosage for display (best-effort).
	medName, medDosage := "", ""
	if med, err := s.store.GetMedication(intake.MedicationID); err != nil {
		slog.Error("GetMedication for intake failed", "intakeID", intakeID, "error", err)
	} else if med != nil {
		medName = med.Name
		medDosage = med.Dosage
	}

	// Revert to PENDING with zero taken_at.
	if err := s.store.UpdateIntake(intakeID, time.Time{}, "PENDING"); err != nil {
		return "", "", fmt.Errorf("update intake %d: %w", intakeID, err)
	}

	// Increment inventory (reverse the decrement). Best-effort.
	// NOTE: if the original decrement on confirm failed (also best-effort),
	// this increment adds stock that was never removed. Accepted limitation
	// of the best-effort inventory system; proper tracking would require
	// a schema change to record whether the decrement actually succeeded.
	if err := s.store.DecrementInventory(intake.MedicationID, -1); err != nil {
		slog.Error("DecrementInventory (undo) failed", "intakeID", intakeID, "error", err)
	}

	return medName, medDosage, nil
}

func (s *medicationService) DeleteFutureIntake(intakeID int64) ([]int, string, string, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, "", "", fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" || !intake.ScheduledAt.After(time.Now()) {
		return nil, "", "", ErrNotFutureIntake
	}

	medName, medDosage := "", ""
	if med, err := s.store.GetMedication(intake.MedicationID); err != nil {
		slog.Error("GetMedication for intake failed", "intakeID", intakeID, "error", err)
	} else if med != nil {
		medName = med.Name
		medDosage = med.Dosage
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		slog.Error("GetIntakeReminders failed", "intakeID", intakeID, "error", err)
	}

	if err := s.store.DeleteIntake(intakeID); err != nil {
		return nil, "", "", fmt.Errorf("delete intake %d: %w", intakeID, err)
	}

	return reminders, medName, medDosage, nil
}

func (s *medicationService) SilenceIntake(intakeID int64) ([]int, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, ErrNotPending
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		slog.Error("GetIntakeReminders failed", "intakeID", intakeID, "error", err)
	}

	snoozeUntil := time.Now().Add(24 * time.Hour)
	if err := s.store.SnoozeIntake(intakeID, snoozeUntil); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotPending
		}
		return nil, fmt.Errorf("snooze intake %d: %w", intakeID, err)
	}

	return reminders, nil
}
