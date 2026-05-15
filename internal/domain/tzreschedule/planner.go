package tzreschedule

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// PlannerStore is the minimal set of store methods required by PlannerService.
type PlannerStore interface {
	List(showArchived bool) ([]store.Medication, error)
	ListIntakeHistory(medID int, days int) ([]store.IntakeLog, error)
	GetPlanByHash(hash string) (*store.TZTransitionPlan, error)
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
	GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error)
	// CreateTZTransitionPlanWithSteps atomically creates a plan and its steps in one transaction.
	CreateTZTransitionPlanWithSteps(plan *store.TZTransitionPlan, steps []store.TZTransitionStep) (int64, error)
}

// PlannerService manages idempotent generation and lifecycle of timezone transition plans.
type PlannerService interface {
	// GenerateIfChanged creates a new transition plan when the timezone has changed and
	// no identical plan was generated recently. Returns true when a new plan was actually
	// created (false for idempotent skips, zero-step results, etc.). Errors are non-fatal
	// — callers should log them but not surface them to the end user.
	GenerateIfChanged(oldTZ, newTZ string, now time.Time) (bool, error)
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
func (p *plannerService) GenerateIfChanged(oldTZ, newTZ string, now time.Time) (bool, error) {
	if oldTZ == newTZ {
		return false, nil
	}
	if oldTZ == "" {
		// First-time timezone registration: resolve the system timezone as the
		// effective old timezone. If it already matches the new timezone there is
		// nothing to transition. If it differs, gate the change through the normal
		// approval flow just like any subsequent timezone change, because the
		// scheduler was already running on time.Local and doses would shift.
		oldTZ = time.Local.String()
		if oldTZ == "" || oldTZ == "Local" {
			// time.Local has no readable IANA name (unset TZ on some platforms).
			// We cannot reliably determine the actual offset the scheduler was
			// using, so skip plan generation to avoid computing transition steps
			// from the wrong baseline. The timezone change will apply immediately.
			slog.Warn("tzplanner: cannot resolve system timezone IANA name, skipping plan generation",
				"time_local", oldTZ, "new_tz", newTZ)
			return false, nil
		}
		if oldTZ == newTZ {
			return false, nil
		}
	}

	// If there is an active plan (PENDING_APPROVAL, NOTIFIED, or APPROVED), the
	// scheduler is still running on that plan's OldTZ (for unapproved plans) or
	// mid-transition between OldTZ and NewTZ (for APPROVED plans). In both cases
	// use OldTZ as the baseline so the replacement plan computes the full shift
	// from the original starting point. For APPROVED plans this is conservative
	// (the schedule may be partially shifted toward NewTZ already) but ensures no
	// dose shift is under-counted.
	activePlan, err := p.store.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		return false, err
	}
	if activePlan != nil {
		// If the plan is APPROVED but has no remaining steps, it is effectively
		// complete. Mark it as such and ignore it for baseline purposes — the
		// scheduler has already moved to the plan's NewTZ.
		if activePlan.Status == "APPROVED" {
			pendingSteps, stepErr := p.store.GetPendingStepsForPlan(activePlan.ID)
			if stepErr != nil {
				slog.Warn("tzplanner: failed to check pending steps for APPROVED plan, ignoring it",
					"plan_id", activePlan.ID, "error", stepErr)
				activePlan = nil
			} else if len(pendingSteps) == 0 {
				slog.Info("tzplanner: APPROVED plan has no pending steps, marking COMPLETED",
					"plan_id", activePlan.ID)
				if err := p.store.UpdateTZTransitionPlanStatus(activePlan.ID, "COMPLETED", "all-steps-consumed", "APPROVED"); err != nil {
					slog.Warn("tzplanner: failed to mark plan COMPLETED", "plan_id", activePlan.ID, "error", err)
				}
				activePlan = nil
			}
		}
	}
	if activePlan != nil {
		if activePlan.OldTZ != "" {
			slog.Info("tzplanner: using active plan's OldTZ as baseline instead of stored timezone",
				"stored_old_tz", oldTZ, "plan_old_tz", activePlan.OldTZ,
				"plan_id", activePlan.ID, "plan_status", activePlan.Status)
			oldTZ = activePlan.OldTZ
		}
		// If the corrected baseline equals the new TZ, there is nothing to transition.
		if oldTZ == newTZ {
			// Still cancel the now-irrelevant active plan.
			if cancelErr := p.CancelActivePlan("superseded-no-change"); cancelErr != nil {
				return false, cancelErr
			}
			return false, nil
		}
	}

	// Load active (non-archived) medications.
	meds, err := p.store.List(false)
	if err != nil {
		return false, err
	}

	// Build last-intake map from the last 30 days of history.
	lastIntakes := make(map[int64]time.Time, len(meds))
	for _, med := range meds {
		history, err := p.store.ListIntakeHistory(int(med.ID), 30)
		if err != nil {
			slog.Error("tzplanner: ListIntakeHistory failed", "med_id", med.ID, "error", err)
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
		return false, err
	}

	sum := sha256.Sum256([]byte(inputsJSON))
	planHash := hex.EncodeToString(sum[:])

	// Idempotency check: skip if an identical non-terminal plan was generated within 24h.
	// Terminal statuses (REJECTED, CANCELLED, EXPIRED) do not block a new plan — the user
	// may legitimately re-submit the same timezone change after dismissing it.
	existing, err := p.store.GetPlanByHash(planHash)
	if err != nil {
		return false, err
	}
	if existing != nil && now.Sub(existing.CreatedAt) < 24*time.Hour {
		switch existing.Status {
		case "REJECTED", "CANCELLED", "EXPIRED", "COMPLETED":
			// Terminal plan with same hash — allow creating a new one.
			slog.Info("tzplanner: found terminal plan with same hash, generating new plan",
				"plan_id", existing.ID, "status", existing.Status, "hash", planHash)
		default:
			slog.Info("tzplanner: identical plan already exists, skipping", "plan_id", existing.ID, "hash", planHash)
			return false, nil
		}
	}

	// Active plans are cancelled atomically inside CreateTZTransitionPlanWithSteps
	// to avoid a TOCTOU gap where the scheduler sees no active plan between the
	// cancel and insert.

	steps, summary, err := GeneratePlan(input)
	if err != nil {
		return false, err
	}

	if len(steps) == 0 {
		slog.Info("tzplanner: no steps generated (offsets may be equal)", "old_tz", oldTZ, "new_tz", newTZ)
		return false, nil
	}

	// Serialise steps for the audit column.
	stepsJSON, err := json.Marshal(steps)
	if err != nil {
		return false, err
	}

	plan := &store.TZTransitionPlan{
		OldTZ:      oldTZ,
		NewTZ:      newTZ,
		Status:     "PENDING_APPROVAL",
		StepsJSON:  string(stepsJSON),
		InputsJSON: inputsJSON,
		PlanHash:   planHash,
	}

	// Build store steps (PlanID will be filled in by CreateTZTransitionPlanWithSteps).
	storeSteps := make([]store.TZTransitionStep, 0, len(steps))
	for _, s := range steps {
		storeSteps = append(storeSteps, store.TZTransitionStep{
			MedicationID: s.MedicationID,
			StepNumber:   s.StepNumber,
			ScheduledAt:  s.ScheduledAt,
			Note:         s.Note,
		})
	}

	// Atomically persist plan and steps in a single transaction so that an orphaned
	// PENDING_APPROVAL plan (with no executable steps) can never be created.
	planID, err := p.store.CreateTZTransitionPlanWithSteps(plan, storeSteps)
	if err != nil {
		// The partial unique index on plan_hash catches concurrent identical inserts.
		// Treat this as idempotent success: an identical plan already exists.
		if isUniqueConstraintError(err) {
			slog.Info("tzplanner: concurrent duplicate plan insert detected, treating as idempotent success",
				"hash", planHash, "error", err)
			return false, nil
		}
		return false, err
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
	return true, nil
}

// isUniqueConstraintError checks whether err is a SQLite UNIQUE constraint violation.
func isUniqueConstraintError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// CancelActivePlan transitions ALL active plans (PENDING_APPROVAL/NOTIFIED/APPROVED)
// to CANCELLED. Cancelling in a loop prevents hidden older plans from resurfacing
// if two concurrent timezone changes race and both create a plan.
func (p *plannerService) CancelActivePlan(reason string) error {
	for {
		active, err := p.store.GetLatestActiveOrPendingTZTransitionPlan()
		if err != nil {
			return err
		}
		if active == nil {
			return nil
		}
		if err := p.store.UpdateTZTransitionPlanStatus(active.ID, "CANCELLED", reason, active.Status); err != nil {
			return err
		}
	}
}
