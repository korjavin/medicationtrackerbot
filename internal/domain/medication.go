package domain

import (
	"context"
	"errors"
	"fmt"
	"log"
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
	GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	ConfirmIntake(id int64, takenAt time.Time) error
	ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) error
	SkipIntake(id int64) error
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
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
	ConfirmIntakeWithCleanup(ctx context.Context, intakeID int64, takenAt time.Time) (reminderMsgIDs []int, isSupplement bool, err error)

	// SkipSupplementIntake validates the intake is PENDING and the medication is a
	// supplement, collects reminder message IDs, and marks the intake as skipped.
	// Returns ErrNotSupplement for non-supplement medications.
	SkipSupplementIntake(ctx context.Context, intakeID int64) (reminderMsgIDs []int, err error)

	// LogMedicationNow creates a new intake and immediately confirms it.
	// Used for ad-hoc "log now" without a pre-existing pending record.
	LogMedicationNow(ctx context.Context, userID, medID int64) error

	// ConfirmScheduleWithCleanup batch-confirms all pending intakes for a scheduled
	// time slot and collects all reminder message IDs across those intakes.
	// Returns the reminder message IDs so the caller can delete them.
	ConfirmScheduleWithCleanup(ctx context.Context, userID int64, scheduledAt time.Time) (reminderMsgIDs []int, err error)
}

type medicationService struct {
	store MedicationStore
}

// NewMedicationService creates a new MedicationService backed by the given store.
func NewMedicationService(s MedicationStore) MedicationService {
	return &medicationService{store: s}
}

func (s *medicationService) ConfirmIntakeWithCleanup(_ context.Context, intakeID int64, takenAt time.Time) ([]int, bool, error) {
	intake, err := s.store.GetIntake(intakeID)
	if err != nil {
		return nil, false, fmt.Errorf("get intake %d: %w", intakeID, err)
	}
	if intake == nil || intake.Status != "PENDING" {
		return nil, false, ErrNotPending
	}

	// Determine supplement status for the caller's UI needs (best-effort).
	isSupplement := false
	if med, err := s.store.GetMedication(intake.MedicationID); err == nil && med != nil {
		isSupplement = med.Supplement
	}

	reminders, err := s.store.GetIntakeReminders(intakeID)
	if err != nil {
		log.Printf("[domain] GetIntakeReminders for intake %d: %v", intakeID, err)
	}

	if err := s.store.ConfirmIntake(intakeID, takenAt); err != nil {
		return nil, false, fmt.Errorf("confirm intake %d: %w", intakeID, err)
	}

	// Inventory decrement is best-effort; a confirmed intake is the source of truth.
	_ = s.store.DecrementInventory(intake.MedicationID, 1)

	return reminders, isSupplement, nil
}

func (s *medicationService) SkipSupplementIntake(_ context.Context, intakeID int64) ([]int, error) {
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
		return nil, fmt.Errorf("skip intake %d: %w", intakeID, err)
	}

	return reminders, nil
}

func (s *medicationService) LogMedicationNow(_ context.Context, userID, medID int64) error {
	now := time.Now()
	logID, err := s.store.CreateIntake(medID, userID, now)
	if err != nil {
		return fmt.Errorf("create intake for med %d: %w", medID, err)
	}
	if err := s.store.ConfirmIntake(logID, now); err != nil {
		return fmt.Errorf("confirm new intake %d: %w", logID, err)
	}
	// Inventory decrement is best-effort.
	_ = s.store.DecrementInventory(medID, 1)
	return nil
}

func (s *medicationService) ConfirmScheduleWithCleanup(_ context.Context, userID int64, scheduledAt time.Time) ([]int, error) {
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

	if err := s.store.ConfirmIntakesBySchedule(userID, scheduledAt, time.Now()); err != nil {
		return nil, fmt.Errorf("confirm intakes by schedule: %w", err)
	}

	for _, p := range pending {
		_ = s.store.DecrementInventory(p.MedicationID, 1)
	}

	return allReminders, nil
}
