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

// MedicationStore is the subset of store operations needed for medication
// scheduling. Track D of the scheduling-simplification plan (Task 11)
// removed the tz_transition_steps-direct methods — the scheduler now reads
// pre-materialized transition-step intakes from intake_log directly.
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
	// Pre-materialized transition-step intakes + symmetric dedup.
	GetDueTZStepIntakes(asOf time.Time) ([]store.IntakeLog, error)
	CountFuturePendingTZStepIntakesForPlan(planID int64, asOf time.Time) (int, error)
	MedsWithFuturePendingTZStepsForPlan(planID int64, asOf time.Time) ([]int64, error)
	HasIntakeNearScheduledTime(medID int64, target time.Time, window time.Duration) (bool, error)
	// TZ-aware scheduling.
	GetCurrentTimezone() (string, error)
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
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
	Target    time.Time
	Meds      []store.Medication
	IntakeIDs map[int64]int64 // medID → pre-existing intake_log id (set for tz_step rows; 0 means create new)
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

	// Completion check: an APPROVED plan whose pre-materialized step
	// intakes have all had their times arrive (no PENDING tz_step rows with
	// scheduled_at_unix > now) is done from the scheduler's perspective —
	// flip its status to COMPLETED so future ticks ignore it. Pre-Track-D,
	// the equivalent check looked at tz_transition_steps.consumed_at; the
	// new condition is observably the same because every step is
	// materialized at approve time and the scheduler reads from intake_log
	// thereafter.
	if activePlan != nil && activePlan.Status == "APPROVED" {
		remaining, err := c.store.CountFuturePendingTZStepIntakesForPlan(activePlan.ID, now)
		if err != nil {
			slog.Warn("medication scheduler: failed to count pending tz_step intakes, leaving plan APPROVED",
				"plan_id", activePlan.ID, "error", err)
		} else if remaining == 0 {
			if err := c.store.UpdateTZTransitionPlanStatus(activePlan.ID, "COMPLETED", "all-steps-consumed", "APPROVED"); err != nil {
				slog.Warn("medication scheduler: failed to mark completed plan",
					"plan_id", activePlan.ID, "error", err)
			} else {
				slog.Info("medication scheduler: transition plan completed, all step times arrived",
					"plan_id", activePlan.ID)
			}
			activePlan = nil
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

	// Normal-schedule targets only. Pre-materialized tz_step rows are
	// surfaced separately from intake_log below — medplan stays out of the
	// transition-plan picture in the scheduler tick.
	targets := medplan.PlanDoses(medplan.Inputs{
		Medications: meds,
		UserLoc:     userLoc,
		Now:         now,
		// Window == 0 → fire mode (only at-or-before now).
	})

	schedulesToCheck := make([]store.MedicationSchedule, 0, len(targets))
	for _, t := range targets {
		schedulesToCheck = append(schedulesToCheck, store.MedicationSchedule{
			MedID:       t.MedicationID,
			ScheduledAt: t.ScheduledAt,
		})
	}

	// Batch query all required schedules.
	batchMap, err := c.store.BatchGetIntakesBySchedule(schedulesToCheck)
	if err != nil {
		slog.Error("medication scheduler: error checking intake existence in batch", "error", err)
		return err
	}

	groups := make(map[int64]*notificationGroup)

	// 1) Surface PENDING source='tz_step' rows due-now as fire-targets.
	//    These already exist in intake_log (pre-materialized at approve
	//    time); we just need to fire the notification and record the
	//    reminder against the existing intake id.
	dueTZStepRows, err := c.store.GetDueTZStepIntakes(now)
	if err != nil {
		slog.Warn("medication scheduler: failed to load due tz_step intakes, skipping plan-step firing",
			"error", err)
	}
	for _, row := range dueTZStepRows {
		med, ok := medByID[row.MedicationID]
		if !ok || med.Archived {
			continue
		}
		ts := row.ScheduledAt.Unix()
		g, has := groups[ts]
		if !has {
			g = &notificationGroup{
				Target:    row.ScheduledAt,
				IntakeIDs: make(map[int64]int64),
			}
			groups[ts] = g
		}
		// Skip if this med was already added to the group via a normal
		// target below — should not happen but defensive against the
		// (medplan target == row.ScheduledAt) coincidence.
		if _, exists := g.IntakeIDs[med.ID]; exists {
			continue
		}
		g.Meds = append(g.Meds, med)
		g.IntakeIDs[med.ID] = row.ID
		slog.Info("medication scheduler: pre-materialized step fired",
			"intake_id", row.ID,
			"tz_plan_id", row.TZPlanID,
			"tz_step_number", row.TZStepNumber,
			"medID", med.ID,
			"scheduledAt", row.ScheduledAt)
	}

	// "Plan owns this med" suppression: while an APPROVED plan still has
	// future PENDING tz_step rows for a medication, the plan is the
	// authoritative dosing schedule for it — every dose during the transition
	// window is materialised as a tz_step row, and normal-schedule slots that
	// fall in a gap > 2*minInterval between consecutive steps would otherwise
	// slip past the ±minInterval dedup below. This restores the pre-Track-D
	// "plan owns this medication while steps remain" behaviour.
	ownedByPlan := map[int64]bool{}
	if activePlan != nil && activePlan.Status == "APPROVED" {
		owned, err := c.store.MedsWithFuturePendingTZStepsForPlan(activePlan.ID, now)
		if err != nil {
			slog.Warn("medication scheduler: failed to load meds with future pending tz_step rows, falling back to ±minInterval dedup only",
				"plan_id", activePlan.ID, "error", err)
		}
		for _, id := range owned {
			ownedByPlan[id] = true
		}
	}

	// 2) Evaluate normal-schedule targets. Skip any whose exact slot is
	//    already in intake_log (BatchGet) and any whose ±minInterval band
	//    overlaps an existing PENDING/TAKEN intake row (new symmetric
	//    dedup replacing the old consumed-step overlap guard).
	for _, t := range targets {
		med, ok := medByID[t.MedicationID]
		if !ok {
			continue
		}

		// Plan-owns-med suppression (see comment above the loop).
		if ownedByPlan[t.MedicationID] {
			slog.Info("medication scheduler: skipping normal target — plan owns this med",
				"medID", t.MedicationID, "scheduledAt", t.ScheduledAt, "plan_id", activePlan.ID)
			continue
		}

		// Exact-match dedup: existing intake at this scheduled_at_unix.
		if existing := batchMap[store.MedicationSchedule{MedID: med.ID, ScheduledAt: t.ScheduledAt.UTC()}]; existing != nil {
			continue
		}

		// Symmetric ±minInterval dedup: a PENDING or TAKEN intake within
		// minInterval of this target covers the same dose. The legacy
		// asymmetric overlap guard in medplan looked only at the
		// `target.Sub(consumedStepTime)` side; the new predicate also
		// catches a target proposed before an existing step intake (see
		// dedup_equivalence_test.go for the side-by-side proof).
		cfg, scfgErr := med.ValidSchedule()
		if scfgErr == nil && cfg != nil {
			minInterval := tzreschedule.MinDoseInterval(
				tzreschedule.NominalIntervalHours(cfg),
				tzreschedule.NormalizePolicy(med.TZShiftPolicy),
			)
			if minInterval > 0 {
				near, err := c.store.HasIntakeNearScheduledTime(med.ID, t.ScheduledAt, minInterval)
				if err != nil {
					slog.Warn("medication scheduler: dedup query failed, proceeding to create intake anyway",
						"medID", med.ID, "scheduledAt", t.ScheduledAt, "error", err)
				} else if near {
					slog.Info("medication scheduler: dedup skip",
						"medID", med.ID, "proposed_unix", t.ScheduledAt.Unix())
					continue
				}
			}
		}

		ts := t.ScheduledAt.Unix()
		g, has := groups[ts]
		if !has {
			g = &notificationGroup{
				Target:    t.ScheduledAt,
				IntakeIDs: make(map[int64]int64),
			}
			groups[ts] = g
		}
		if _, exists := g.IntakeIDs[med.ID]; exists {
			// med already attached at this slot (e.g. tz_step row covered
			// it). Skip — never produce two notifications for the same
			// (med, scheduled_at).
			continue
		}
		g.Meds = append(g.Meds, med)
		g.IntakeIDs[med.ID] = 0 // 0 → create a new intake below
	}

	for _, group := range groups {
		if len(group.Meds) == 0 {
			continue
		}

		var intakeIDs []int64
		intakeByMedication := make(map[int64]int64, len(group.Meds))
		var preMatStepIDs []int64
		for _, med := range group.Meds {
			existingID := group.IntakeIDs[med.ID]
			if existingID != 0 {
				// Pre-materialized tz_step row: do not create another
				// intake — wire the existing id into the notification.
				intakeIDs = append(intakeIDs, existingID)
				intakeByMedication[med.ID] = existingID
				preMatStepIDs = append(preMatStepIDs, existingID)
				slog.Info("Triggering medication (pre-materialized step)",
					"name", med.Name, "dosage", med.Dosage, "schedule", med.Schedule, "target", group.Target, "intakeID", existingID)
				continue
			}
			slog.Info("Triggering medication", "name", med.Name, "dosage", med.Dosage, "schedule", med.Schedule, "target", group.Target)
			id, err := c.store.CreateIntake(med.ID, c.allowedUserID, group.Target)
			if err != nil {
				slog.Error("Failed to create intake log", "error", err)
				continue
			}
			intakeIDs = append(intakeIDs, id)
			intakeByMedication[med.ID] = id
		}

		// Set the GetDueTZStepIntakes dedup gate for pre-materialized rows
		// synchronously, with a sentinel msgID=0. The async Notify callback
		// below only writes intake_reminders when a notifier returns a non-
		// zero msgID, so a WebPush-only deployment (WebPush.Send always
		// returns 0) would otherwise leave the gate clear and re-fire the
		// same row on every minute tick until the user confirms or skips.
		// Normal-schedule rows don't need this — their dedup is the
		// intake_log row created by CreateIntake above.
		for _, iID := range preMatStepIDs {
			if err := c.store.AddIntakeReminder(iID, 0); err != nil {
				slog.Error("Failed to set tz_step fire gate", "intakeID", iID, "error", err)
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
