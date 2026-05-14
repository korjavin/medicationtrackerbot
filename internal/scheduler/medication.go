package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/medplan"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MedicationStore is the subset of store operations needed for medication scheduling.
type MedicationStore interface {
	GetMedicationEnabled(ctx context.Context) (bool, error)
	ListMedications(archived bool) ([]store.Medication, error)
	GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error)
	BatchGetIntakesBySchedule(schedules []store.MedicationSchedule) (map[store.MedicationSchedule]*store.IntakeLog, error)
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	AddIntakeReminder(intakeID int64, msgID int) error
	GetPendingIntakes() ([]store.IntakeLog, error)
	GetPendingIntakesForMedication(medID int64) ([]store.IntakeLog, error)
	GetMedication(id int64) (*store.Medication, error)
	GetMedicationsLowOnStock(days int) ([]store.Medication, error)
	GetDaysOfStockRemaining(med *store.Medication) *float64
	SnoozeIntake(id int64, snoozeUntil time.Time) error
	// TZ-aware scheduling
	GetCurrentTimezone() (string, error)
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
	GetLatestCompletedTZTransitionPlan() (*store.TZTransitionPlan, error)
	GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error)
	GetLatestConsumedStepTimePerMed(planID int64) (map[int64]time.Time, error)
	MarkStepConsumed(stepID int64, consumedAt time.Time) error
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
}

// MedicationChecker checks for due medications and sends notifications.
type MedicationChecker struct {
	NotifyHelper
	store MedicationStore
	now   func() time.Time // injectable clock; defaults to time.Now
}

// notificationGroup accumulates medications that share a notification target time.
type notificationGroup struct {
	Target  time.Time
	Meds    []store.Medication
	StepIDs map[int64]int64 // medID → stepID from transition plan (0 = normal schedule)
}

// findNearMatchPendingIntake returns the existing PENDING intake whose
// scheduled_at is closest to stepScheduledAt and within the medication's
// per-policy minInterval window, or nil. Returns nil when the schedule is
// unparsable (the med should not have made it into the plan, so let the
// caller fall through to the normal create-intake path).
//
// Pending intakes covered by a previously-consumed step in the same plan
// (mirroring the medplan overlap guard) are skipped so we don't fold the
// current step into an intake that already "belongs" to an earlier consumed
// step.
func (c *MedicationChecker) findNearMatchPendingIntake(med store.Medication, stepScheduledAt time.Time, consumedStepTimeByMed map[int64]time.Time) *store.IntakeLog {
	cfg, err := med.ValidSchedule()
	if err != nil || cfg == nil {
		return nil
	}
	minInterval := tzreschedule.MinDoseInterval(
		tzreschedule.NominalIntervalHours(cfg),
		tzreschedule.NormalizePolicy(med.TZShiftPolicy),
	)
	if minInterval <= 0 {
		return nil
	}
	pending, err := c.store.GetPendingIntakesForMedication(med.ID)
	if err != nil {
		slog.Warn("medication scheduler: failed to load pending intakes for near-match dedup",
			"medID", med.ID, "error", err)
		return nil
	}
	consumedStepAt, hasConsumedStep := consumedStepTimeByMed[med.ID]
	var best *store.IntakeLog
	var bestDelta time.Duration
	for i := range pending {
		p := &pending[i]
		if p.TakenAt != nil {
			continue
		}
		if hasConsumedStep {
			// Mirror medplan's overlap guard: intakes at-or-before the
			// consumed step (old timezone) or within minInterval after it
			// already belong to that step.
			if !p.ScheduledAt.After(consumedStepAt) {
				continue
			}
			if p.ScheduledAt.Sub(consumedStepAt) <= minInterval {
				continue
			}
		}
		delta := p.ScheduledAt.Sub(stepScheduledAt)
		if delta < 0 {
			delta = -delta
		}
		if delta > minInterval {
			continue
		}
		if best == nil || delta < bestDelta || (delta == bestDelta && p.ID < best.ID) {
			best = p
			bestDelta = delta
		}
	}
	return best
}

func (c *MedicationChecker) Check(ctx context.Context) error {
	enabled, err := c.store.GetMedicationEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	if c.now == nil {
		c.now = time.Now
	}
	now := c.now()

	// Load user timezone; fall back to time.Local if not set or invalid.
	userLoc := time.Local
	if tz, tzErr := c.store.GetCurrentTimezone(); tzErr != nil {
		slog.Warn("medication scheduler: failed to get user timezone, using system TZ", "error", tzErr)
	} else if tz != "" {
		if loc, locErr := time.LoadLocation(tz); locErr != nil {
			slog.Warn("medication scheduler: invalid user timezone, using system TZ", "tz", tz, "error", locErr)
		} else {
			userLoc = loc
		}
	}

	// Load the latest active transition plan.
	activePlan, err := c.store.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		slog.Warn("medication scheduler: failed to load transition plan, proceeding without it", "error", err)
		activePlan = nil
	}

	// If the plan is awaiting user decision (PENDING_APPROVAL or NOTIFIED), preserve the
	// old timezone for normal scheduling so doses continue on the existing schedule until
	// the user explicitly approves or rejects the transition.
	if activePlan != nil && (activePlan.Status == "PENDING_APPROVAL" || activePlan.Status == "NOTIFIED") {
		if activePlan.OldTZ == "" {
			// No timezone was stored before this plan was created; preserve the system
			// timezone (time.Local) rather than resolving "" to UTC via LoadLocation.
			userLoc = time.Local
			slog.Info("medication scheduler: plan awaiting approval, preserving system timezone (no prior TZ stored)",
				"plan_id", activePlan.ID, "status", activePlan.Status)
		} else if oldLoc, locErr := time.LoadLocation(activePlan.OldTZ); locErr == nil {
			userLoc = oldLoc
			slog.Info("medication scheduler: plan awaiting approval, preserving old timezone",
				"plan_id", activePlan.ID, "old_tz", activePlan.OldTZ, "status", activePlan.Status)
		}
	}

	// Step-based plan execution: load the unconsumed steps for an APPROVED
	// plan so medplan.PlanDoses can prefer them over normal scheduling, and
	// capture the plan id BEFORE any branch nils activePlan so the
	// overlap-guard query below still finds the consumed-step times this
	// tick must honour.
	var pendingSteps []store.TZTransitionStep
	var lastConsumedPlanID int64
	if activePlan != nil && (activePlan.Status == "APPROVED" || activePlan.Status == "COMPLETED") {
		lastConsumedPlanID = activePlan.ID
	} else if activePlan == nil {
		// No active plan, but the most recent COMPLETED plan still owns the
		// overlap-guard data: when a tick consumed the final step it also
		// flipped the status to COMPLETED, and the very next tick must keep
		// suppressing the normal-schedule slots the just-consumed steps
		// superseded — otherwise a westbound landing produces a duplicate
		// "21:30" reminder right after the user took the final transition
		// step at 22:30. GetLatestActiveOrPendingTZTransitionPlan deliberately
		// excludes COMPLETED rows so this fallback is the only path that
		// surfaces the plan id again.
		if completed, err := c.store.GetLatestCompletedTZTransitionPlan(); err == nil && completed != nil {
			lastConsumedPlanID = completed.ID
		} else if err != nil {
			slog.Warn("medication scheduler: failed to load completed plan for overlap guard", "error", err)
		}
	}
	if activePlan != nil && activePlan.Status == "APPROVED" {
		steps, err := c.store.GetPendingStepsForPlan(activePlan.ID)
		if err != nil {
			// Transient step-load failure: fall back to the plan's old timezone
			// so medications continue on the pre-transition schedule rather
			// than jumping to the fully-shifted new timezone.
			slog.Warn("medication scheduler: failed to load plan steps, using plan old timezone",
				"plan_id", activePlan.ID, "old_tz", activePlan.OldTZ, "error", err)
			if activePlan.OldTZ != "" {
				if oldLoc, locErr := time.LoadLocation(activePlan.OldTZ); locErr == nil {
					userLoc = oldLoc
				}
			}
			activePlan = nil
		} else if len(steps) == 0 {
			// Transition complete — mark the plan COMPLETED so it stops
			// shadowing the medication schedule next tick.
			if err := c.store.UpdateTZTransitionPlanStatus(activePlan.ID, "COMPLETED", "all-steps-consumed", "APPROVED"); err != nil {
				slog.Warn("medication scheduler: failed to mark completed plan", "plan_id", activePlan.ID, "error", err)
			} else {
				slog.Info("medication scheduler: transition plan completed, all steps consumed",
					"plan_id", activePlan.ID)
			}
			activePlan = nil
		} else {
			pendingSteps = steps
			distinctMeds := map[int64]struct{}{}
			for _, s := range steps {
				distinctMeds[s.MedicationID] = struct{}{}
			}
			slog.Info("medication scheduler: using approved transition plan",
				"plan_id", activePlan.ID, "meds_with_steps", len(distinctMeds))
		}
	}

	// Latest consumed transition-step time per medication. The overlap guard
	// inside medplan.PlanDoses uses these to drop normal-schedule targets
	// that would (a) have fired in the old timezone before the step or
	// (b) prompt a duplicate dose within minInterval after the step. The
	// lookup uses lastConsumedPlanID so a tick that just COMPLETED the plan
	// still suppresses the normal doses overlapping with the steps it just
	// consumed.
	consumedStepTimeByMed := make(map[int64]time.Time)
	if lastConsumedPlanID != 0 {
		if m, err := c.store.GetLatestConsumedStepTimePerMed(lastConsumedPlanID); err != nil {
			slog.Warn("medication scheduler: failed to load consumed step times, ignoring overlap guard",
				"plan_id", lastConsumedPlanID, "error", err)
		} else {
			consumedStepTimeByMed = m
		}
	}

	meds, err := c.store.ListMedications(false)
	if err != nil {
		return err
	}
	medByID := make(map[int64]store.Medication, len(meds))
	for _, m := range meds {
		medByID[m.ID] = m
	}

	// Single source of truth: ask medplan to enumerate every dose target the
	// scheduler should consider firing this tick. medplan handles the plan-
	// vs-normal branching, the StartDate/EndDate window, the weekly weekday
	// gate, and the consumed-step overlap guard; we only need to dedupe
	// against existing intakes and group for notification.
	targets := medplan.PlanDoses(medplan.Inputs{
		Medications:           meds,
		PendingSteps:          pendingSteps,
		ConsumedStepTimeByMed: consumedStepTimeByMed,
		UserLoc:               userLoc,
		Now:                   now,
		// Window == 0 → fire mode (only at-or-before now).
	})

	schedulesToCheck := make([]store.MedicationSchedule, 0, len(targets))
	for _, t := range targets {
		schedulesToCheck = append(schedulesToCheck, store.MedicationSchedule{
			MedID:       t.MedicationID,
			ScheduledAt: t.ScheduledAt,
		})
	}

	// Batch query all required schedules
	batchMap, err := c.store.BatchGetIntakesBySchedule(schedulesToCheck)
	if err != nil {
		slog.Error("medication scheduler: error checking intake existence in batch", "error", err)
		return err
	}

	groups := make(map[int64]*notificationGroup)
	planMedTriggered := make(map[int64]bool) // tracks if a plan step was already triggered for a med

	// --- Pass 2: Evaluate using batched results and trigger ---
	for _, t := range targets {
		med, ok := medByID[t.MedicationID]
		if !ok {
			continue // medplan returned a med id not in our list — defensive
		}
		isPlanStep := t.Source == medplan.SourceTransitionStep
		if isPlanStep {
			if planMedTriggered[med.ID] {
				continue // Only trigger one new step per medication per tick
			}

			existing := batchMap[store.MedicationSchedule{MedID: med.ID, ScheduledAt: t.ScheduledAt.UTC()}]
			if existing != nil {
				// Intake already created (idempotency): ensure step is marked consumed.
				if err := c.store.MarkStepConsumed(t.StepID, now); err != nil {
					slog.Warn("medication scheduler: failed to mark already-scheduled step consumed",
						"stepID", t.StepID, "error", err)
				}
				continue
			}

			// Near-match fallback: a pre-existing PENDING normal intake within
			// minInterval of this step time covers the same dose. Mark the step
			// consumed against it instead of creating a duplicate. Without this
			// the exact-match lookup above misses when the step time inherits
			// second-level drift from a prior taken_at (engine.go anchor).
			if near := c.findNearMatchPendingIntake(med, t.ScheduledAt, consumedStepTimeByMed); near != nil {
				if err := c.store.MarkStepConsumed(t.StepID, now); err != nil {
					slog.Warn("medication scheduler: failed to mark step consumed against near-match intake",
						"stepID", t.StepID, "medID", med.ID, "error", err)
				} else {
					slog.Info("medication scheduler: plan step consumed against pre-existing near-match intake",
						"stepID", t.StepID,
						"medID", med.ID,
						"stepScheduledAt", t.ScheduledAt,
						"existingIntakeID", near.ID,
						"existingScheduledAt", near.ScheduledAt,
						"deltaSeconds", int64(t.ScheduledAt.Sub(near.ScheduledAt).Abs().Seconds()))
				}
				planMedTriggered[med.ID] = true
				continue
			}

			ts := t.ScheduledAt.Unix()
			if _, ok := groups[ts]; !ok {
				groups[ts] = &notificationGroup{
					Target:  t.ScheduledAt,
					StepIDs: make(map[int64]int64),
				}
			}
			groups[ts].Meds = append(groups[ts].Meds, med)
			groups[ts].StepIDs[med.ID] = t.StepID
			planMedTriggered[med.ID] = true
		} else {
			existing := batchMap[store.MedicationSchedule{MedID: med.ID, ScheduledAt: t.ScheduledAt.UTC()}]
			if existing == nil {
				ts := t.ScheduledAt.Unix()
				if _, ok := groups[ts]; !ok {
					groups[ts] = &notificationGroup{
						Target:  t.ScheduledAt,
						StepIDs: make(map[int64]int64),
					}
				}
				groups[ts].Meds = append(groups[ts].Meds, med)
			}
		}
	}

	for _, group := range groups {
		if len(group.Meds) == 0 {
			continue
		}

		var intakeIDs []int64
		intakeByMedication := make(map[int64]int64, len(group.Meds))
		for _, med := range group.Meds {
			slog.Info("Triggering medication", "name", med.Name, "dosage", med.Dosage, "schedule", med.Schedule, "target", group.Target)
			id, err := c.store.CreateIntake(med.ID, c.allowedUserID, group.Target)
			if err != nil {
				slog.Error("Failed to create intake log", "error", err)
			} else {
				intakeIDs = append(intakeIDs, id)
				intakeByMedication[med.ID] = id

				// If this dose came from a transition plan step, mark it consumed.
				if stepID := group.StepIDs[med.ID]; stepID != 0 {
					if err := c.store.MarkStepConsumed(stepID, now); err != nil {
						slog.Warn("medication scheduler: failed to mark step consumed",
							"stepID", stepID, "medID", med.ID, "error", err)
					} else {
						slog.Info("medication scheduler: transition step consumed",
							"stepID", stepID, "medID", med.ID, "scheduledAt", group.Target)
					}
				}
			}
		}

		var sb strings.Builder
		fmt.Fprintf(&sb, "💊 Time to take your medications (%s):\n\n", group.Target.In(userLoc).Format("15:04"))
		for _, m := range group.Meds {
			if m.Dosage != "" {
				fmt.Fprintf(&sb, "- %s (%s)\n", m.Name, m.Dosage)
			} else {
				fmt.Fprintf(&sb, "- %s\n", m.Name)
			}
		}
		text := sb.String()

		// We still send one batched notification for Telegram to avoid spamming the user.
		// However, for WebPush we will construct individual notifications per medication.

		var actions []notifier.Action
		for _, m := range group.Meds {
			data := "confirm:" + strconv.FormatInt(m.ID, 10)
			if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
				data = "confirm_intake:" + strconv.FormatInt(intakeID, 10)
			}
			actions = append(actions, notifier.Action{ID: data, Label: "Take " + m.Name})
			if intakeID := intakeByMedication[m.ID]; intakeID != 0 {
				actions = append(actions, notifier.Action{
					ID:    "skip_intake:" + strconv.FormatInt(intakeID, 10),
					Label: "Skip " + m.Name,
				})
			}
		}
		actions = append(actions, notifier.Action{
			ID:    "confirm_schedule:" + strconv.FormatInt(group.Target.Unix(), 10),
			Label: "✅✅ Confirm ALL",
		})

		medNames := make([]string, len(group.Meds))
		medIDs := make([]int64, len(group.Meds))
		for i, m := range group.Meds {
			name := m.Name
			if m.Dosage != "" {
				name += " " + m.Dosage
			}
			medNames[i] = name
			medIDs[i] = m.ID
		}

		// Batched payload logic remains for Telegram compatibility
		n := notifier.Notification{
			Text:    text,
			Actions: actions,
			Tag:     fmt.Sprintf("medication-%s", group.Target.Format(time.RFC3339)),
			Metadata: map[string]any{
				"type":             "medication_batch", // Changed to medication_batch so WebPush notifier ignores it if we decide to
				"scheduled_at":     group.Target.Format(time.RFC3339),
				"medication_ids":   medIDs,
				"medication_names": medNames,
				"intake_ids":       intakeIDs,
			},
		}

		iIDs := intakeIDs
		c.Notify(ctx, n, func(msgID int) {
			for _, iID := range iIDs {
				if err := c.store.AddIntakeReminder(iID, msgID); err != nil {
					slog.Error("Failed to add intake reminder", "intakeID", iID, "msgID", msgID, "error", err)
				}
			}
		})

		// Send individual notifications for WebPush
		for _, m := range group.Meds {
			intakeID := intakeByMedication[m.ID]
			if intakeID == 0 {
				continue // Skip if intake creation failed
			}
			indivN := notifier.Notification{
				Text: fmt.Sprintf("💊 Time to take: %s", m.Name),
				Actions: []notifier.Action{
					{ID: fmt.Sprintf("confirm_%d", intakeID), Label: "Confirm"},
					{ID: fmt.Sprintf("skip_%d", intakeID), Label: "Skip"},
				},
				Tag: fmt.Sprintf("medication-%d", intakeID),
				Metadata: map[string]any{
					"type":          "medication_individual",
					"scheduled_at":  group.Target.Format(time.RFC3339),
					"medication_id": m.ID,
					"intake_id":     intakeID,
				},
			}
			// Notify but we don't care about msgIDs for these individual ones since they are webpush specific
			c.Notify(ctx, indivN, func(msgID int) {})
		}
	}

	return nil
}
