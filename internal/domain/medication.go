package domain

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrNotPending is returned when an intake is not in PENDING state.
var ErrNotPending = errors.New("intake is not pending")

// ErrNotSupplement is returned when skip is attempted on a non-supplement medication.
var ErrNotSupplement = errors.New("skip is only available for supplements")

// MedicationStore is the narrow store interface required by MedicationService.
type MedicationStore interface {
	GetIntake(id int64) (*store.IntakeLog, error)
	GetMedication(id int64) (*store.Medication, error)
	GetIntakeReminders(intakeID int64) ([]int, error)
	GetPendingIntakes() ([]store.IntakeLog, error)
	GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	ConfirmIntake(id int64, takenAt time.Time) error
	ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error)
	SkipIntake(id int64) error
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error)
	DecrementInventory(medID int64, qty int) error
}

// MedicationService is the public interface for medication business logic.
// It contains only domain decisions; the caller (bot layer) handles all
// Telegram message sending and deletion.
type MedicationService interface {
	// ConfirmIntakeWithCleanup validates the intake is PENDING, collects reminder
	// message IDs, confirms the intake, and decrements inventory.
	// Returns the reminder message IDs so the caller can delete them, and whether
	// the confirmed medication is a supplement (for UI purposes).
	ConfirmIntakeWithCleanup(intakeID int64, takenAt time.Time) (reminderMsgIDs []int, isSupplement bool, err error)

	// SkipSupplementIntake validates the intake is PENDING and the medication is a
	// supplement, collects reminder message IDs, and marks the intake as skipped.
	// Returns ErrNotSupplement for non-supplement medications.
	SkipSupplementIntake(intakeID int64) (reminderMsgIDs []int, err error)

	// LogMedicationNow creates a new intake and immediately confirms it.
	// Used for ad-hoc "log now" without a pre-existing pending record.
	LogMedicationNow(userID, medID int64) error

	// ConfirmScheduleWithCleanup batch-confirms all pending intakes for a scheduled
	// time slot and collects all reminder message IDs across those intakes.
	// Returns the reminder message IDs so the caller can delete them.
	ConfirmScheduleWithCleanup(userID int64, scheduledAt time.Time) (reminderMsgIDs []int, err error)

	// ConfirmMedicationByMedID finds the first pending intake for a medication and confirms it.
	// Used by the legacy confirm: callback which only carries a medication ID, not an intake ID.
	// Returns ErrNotPending if no pending intake exists for the medication.
	ConfirmMedicationByMedID(medID int64, takenAt time.Time) (reminderMsgIDs []int, isSupplement bool, err error)
}

type medicationService struct {
	store MedicationStore
}

// NewMedicationService creates a new MedicationService backed by the given store.
func NewMedicationService(s MedicationStore) MedicationService {
	return &medicationService{store: s}
}

func (s *medicationService) ConfirmIntakeWithCleanup(intakeID int64, takenAt time.Time) ([]int, bool, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, false, fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, false, ErrNotPending
	}

	// Determine supplement status for the caller's UI needs (best-effort).
	isSupplement := false
	if med, err := s.store.GetMedication(intake.MedicationID); err != nil {
		log.Printf("[domain] GetMedication for intake %d: %v", intakeID, err)
	} else if med != nil {
		isSupplement = med.Supplement
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		log.Printf("[domain] GetIntakeReminders for intake %d: %v", intakeID, err)
	}

	if err := s.store.ConfirmIntake(intakeID, takenAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, ErrNotPending
		}
		return nil, false, fmt.Errorf("confirm intake %d: %w", intakeID, err)
	}

	// Inventory decrement is best-effort; a confirmed intake is the source of truth.
	if err := s.store.DecrementInventory(intake.MedicationID, 1); err != nil {
		log.Printf("[domain] DecrementInventory for intake %d: %v", intakeID, err)
	}

	return reminders, isSupplement, nil
}

func (s *medicationService) SkipSupplementIntake(intakeID int64) ([]int, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, ErrNotPending
	}

	med, err := s.store.GetMedication(intake.MedicationID)
	if err != nil {
		return nil, fmt.Errorf("get medication %d: %w", intake.MedicationID, err)
	}
	if med == nil || !med.Supplement {
		return nil, ErrNotSupplement
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		log.Printf("[domain] GetIntakeReminders for intake %d: %v", intakeID, err)
	}

	if err := s.store.SkipIntake(intakeID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotPending
		}
		return nil, fmt.Errorf("skip intake %d: %w", intakeID, err)
	}

	return reminders, nil
}

func (s *medicationService) LogMedicationNow(userID, medID int64) error {
	now := time.Now()
	// CreateManualIntake inserts directly with status='TAKEN', avoiding a separate ConfirmIntake
	// call that could leave a dangling PENDING record on partial failure.
	if _, err := s.store.CreateManualIntake(medID, userID, now); err != nil {
		return fmt.Errorf("create manual intake for med %d: %w", medID, err)
	}
	// Inventory decrement is best-effort.
	if err := s.store.DecrementInventory(medID, 1); err != nil {
		log.Printf("[domain] DecrementInventory for med %d: %v", medID, err)
	}
	return nil
}

func (s *medicationService) ConfirmScheduleWithCleanup(userID int64, scheduledAt time.Time) ([]int, error) {
	pending, err := s.store.GetPendingIntakesBySchedule(userID, scheduledAt)
	if err != nil {
		return nil, fmt.Errorf("get pending intakes by schedule: %w", err)
	}

	var allReminders []int
	for _, p := range pending {
		reminders, err := s.store.GetIntakeReminders(p.ID)
		if err != nil {
			log.Printf("[domain] GetIntakeReminders for intake %d: %v", p.ID, err)
		}
		allReminders = append(allReminders, reminders...)
	}

	confirmedIDs, err := s.store.ConfirmIntakesBySchedule(userID, scheduledAt, time.Now())
	if err != nil {
		return nil, fmt.Errorf("confirm intakes by schedule: %w", err)
	}

	// Only decrement inventory for intakes that were actually confirmed by this call
	confirmedIDSet := make(map[int64]bool)
	for _, id := range confirmedIDs {
		confirmedIDSet[id] = true
	}

	for _, p := range pending {
		if confirmedIDSet[p.ID] {
			if err := s.store.DecrementInventory(p.MedicationID, 1); err != nil {
				log.Printf("[domain] DecrementInventory for intake %d: %v", p.ID, err)
			}
		}
	}

	return allReminders, nil
}

func (s *medicationService) ConfirmMedicationByMedID(medID int64, takenAt time.Time) ([]int, bool, error) {
	pending, err := s.store.GetPendingIntakes()
	if err != nil {
		return nil, false, fmt.Errorf("get pending intakes: %w", err)
	}

	// Find all pending intakes for this medication
	var matching []store.IntakeLog
	for _, p := range pending {
		if p.MedicationID == medID {
			matching = append(matching, p)
		}
	}

	if len(matching) == 0 {
		return nil, false, ErrNotPending
	}

	// Sort by ScheduledAt descending to confirm the most recent pending intake
	sort.Slice(matching, func(i, j int) bool {
		return matching[i].ScheduledAt.After(matching[j].ScheduledAt)
	})

	return s.ConfirmIntakeWithCleanup(matching[0].ID, takenAt)
}
