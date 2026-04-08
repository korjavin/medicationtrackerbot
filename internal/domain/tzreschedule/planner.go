package tzreschedule

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// PlannerStore is the minimal set of store methods required by PlannerService.
type PlannerStore interface {
	ListMedications(showArchived bool) ([]store.Medication, error)
	GetIntakeHistory(medID int, days int) ([]store.IntakeLog, error)
	GetPlanByHash(hash string) (*store.TZTransitionPlan, error)
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
	CreateTZTransitionPlan(plan *store.TZTransitionPlan) (int64, error)
	CreateTZTransitionSteps(steps []store.TZTransitionStep) error
}

// PlannerService manages idempotent generation and lifecycle of timezone transition plans.
type PlannerService interface {
	// GenerateIfChanged creates a new transition plan when the timezone has changed and
	// no identical plan was generated recently. Errors are non-fatal — callers should log
	// them but not surface them to the end user.
	GenerateIfChanged(oldTZ, newTZ string, now time.Time) error
	// CancelActivePlan transitions any PENDING_APPROVAL/NOTIFIED/APPROVED plan to
	// CANCELLED with the supplied reason stored as user_action.
	CancelActivePlan(reason string) error
}

type plannerService struct {
	store PlannerStore
}

// NewPlannerService constructs a PlannerService backed by the supplied store.
func NewPlannerService(s PlannerStore) PlannerService {
	return &plannerService{store: s}
}

// GenerateIfChanged is documented on the PlannerService interface.
// NOTE: This first iteration does not auto-generate plans for DST changes when
// the stored IANA timezone name is unchanged, because timezone_history only records
// timezone-string changes; DST drift within the same IANA zone is not tracked.
func (p *plannerService) GenerateIfChanged(oldTZ, newTZ string, now time.Time) error {
	if oldTZ == newTZ {
		return nil
	}

	// Load active (non-archived) medications.
	meds, err := p.store.ListMedications(false)
	if err != nil {
		return err
	}

	// Build last-intake map from the last 30 days of history.
	lastIntakes := make(map[int64]time.Time, len(meds))
	for _, med := range meds {
		history, err := p.store.GetIntakeHistory(int(med.ID), 30)
		if err != nil {
			slog.Error("tzplanner: GetIntakeHistory failed", "med_id", med.ID, "error", err)
			continue
		}
		for _, h := range history {
			if h.Status == "TAKEN" && h.TakenAt != nil {
				lastIntakes[med.ID] = *h.TakenAt
				break
			}
		}
	}

	input := PlanInput{
		Medications:             meds,
		OldTZ:                   oldTZ,
		NewTZ:                   newTZ,
		Now:                     now,
		LastIntakePerMedication: lastIntakes,
	}

	// Truncate now to 1-hour precision for hash stability: two calls within the
	// same hour with identical inputs should map to the same hash.
	hashInput := input
	hashInput.Now = now.Truncate(time.Hour)
	inputsJSON, err := InputsJSON(hashInput)
	if err != nil {
		return err
	}

	sum := sha256.Sum256([]byte(inputsJSON))
	planHash := hex.EncodeToString(sum[:])

	// Idempotency check: skip if an identical plan was generated within 24h.
	existing, err := p.store.GetPlanByHash(planHash)
	if err != nil {
		return err
	}
	if existing != nil && now.Sub(existing.CreatedAt) < 24*time.Hour {
		slog.Info("tzplanner: identical plan already exists, skipping", "plan_id", existing.ID, "hash", planHash)
		return nil
	}

	// Cancel any active plan before generating a new one (TZ changed again).
	if err := p.CancelActivePlan("superseded"); err != nil {
		return err
	}

	steps, summary, err := GeneratePlan(input)
	if err != nil {
		return err
	}

	if len(steps) == 0 {
		slog.Info("tzplanner: no steps generated (offsets may be equal)", "old_tz", oldTZ, "new_tz", newTZ)
		return nil
	}

	// Serialise steps for the audit column.
	stepsJSON, err := json.Marshal(steps)
	if err != nil {
		return err
	}

	plan := &store.TZTransitionPlan{
		OldTZ:      oldTZ,
		NewTZ:      newTZ,
		Status:     "PENDING_APPROVAL",
		StepsJSON:  string(stepsJSON),
		InputsJSON: inputsJSON,
		PlanHash:   planHash,
	}

	planID, err := p.store.CreateTZTransitionPlan(plan)
	if err != nil {
		return err
	}

	// Persist the individual steps for scheduler consumption.
	storeSteps := make([]store.TZTransitionStep, 0, len(steps))
	for _, s := range steps {
		storeSteps = append(storeSteps, store.TZTransitionStep{
			PlanID:       planID,
			MedicationID: s.MedicationID,
			StepNumber:   s.StepNumber,
			ScheduledAt:  s.ScheduledAt,
			Note:         s.Note,
		})
	}
	if err := p.store.CreateTZTransitionSteps(storeSteps); err != nil {
		return err
	}

	slog.Info("tzplanner: plan created",
		"plan_id", planID,
		"old_tz", oldTZ,
		"new_tz", newTZ,
		"direction", summary.Direction,
		"meds_count", len(meds),
		"steps_count", len(steps),
		"max_shift_used", summary.MaxShiftUsed.String(),
		"violations_prevented", len(summary.ViolationsPrevented),
	)
	return nil
}

// CancelActivePlan transitions the most recent active plan to CANCELLED.
func (p *plannerService) CancelActivePlan(reason string) error {
	active, err := p.store.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		return err
	}
	if active == nil {
		return nil
	}
	return p.store.UpdateTZTransitionPlanStatus(active.ID, "CANCELLED", reason, "")
}
