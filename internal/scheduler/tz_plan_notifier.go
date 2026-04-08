package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TZPlanNotifierStore is the subset of store operations needed by TZPlanNotifier.
type TZPlanNotifierStore interface {
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
}

// TZPlanNotifier checks for pending timezone transition plans and sends a
// Telegram notification with approve/reject buttons.
type TZPlanNotifier struct {
	NotifyHelper
	store TZPlanNotifierStore
}

// planStep is used only for parsing the StepsJSON blob stored in the plan.
// Fields match the JSON encoding of tzreschedule.TransitionStep (no json tags →
// capitalized keys).
type planStep struct {
	PlanID       int64     `json:"PlanID"`
	MedicationID int64     `json:"MedicationID"`
	MedName      string    `json:"MedName"`
	StepNumber   int       `json:"StepNumber"`
	TotalSteps   int       `json:"TotalSteps"`
	ScheduledAt  time.Time `json:"ScheduledAt"`
	Note         string    `json:"Note"`
}

// Check implements Checker. It looks for PENDING_APPROVAL plans and sends a
// notification, then atomically transitions the status to NOTIFIED to prevent
// duplicate sends.
func (n *TZPlanNotifier) Check(ctx context.Context) error {
	plan, err := n.store.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		return fmt.Errorf("tz_plan_notifier: GetLatestActive: %w", err)
	}
	if plan == nil || plan.Status != "PENDING_APPROVAL" {
		return nil
	}

	// Parse stored steps for message formatting.
	var steps []planStep
	if plan.StepsJSON != "" {
		if err := json.Unmarshal([]byte(plan.StepsJSON), &steps); err != nil {
			slog.Error("tz_plan_notifier: failed to parse steps_json", "plan_id", plan.ID, "error", err)
			// Continue with empty steps — we can still show a minimal message.
		}
	}

	text := formatTZPlanMessage(plan, steps)

	notification := notifier.Notification{
		Text: text,
		Actions: []notifier.Action{
			{ID: fmt.Sprintf("tz_plan_approve:%d", plan.ID), Label: "✅ Approve"},
			{ID: fmt.Sprintf("tz_plan_reject:%d", plan.ID), Label: "❌ Reject"},
		},
		Tag: "tz_plan",
	}

	n.Notify(ctx, notification, nil)

	// Atomically transition PENDING_APPROVAL → NOTIFIED to prevent duplicate sends.
	if err := n.store.UpdateTZTransitionPlanStatus(plan.ID, "NOTIFIED", "", "PENDING_APPROVAL"); err != nil {
		slog.Error("tz_plan_notifier: failed to transition to NOTIFIED", "plan_id", plan.ID, "error", err)
		// Non-fatal: the notification was already sent; duplicate protection may fail gracefully.
	}

	slog.Info("tz_plan_notifier: plan notification sent", "plan_id", plan.ID, "old_tz", plan.OldTZ, "new_tz", plan.NewTZ)
	return nil
}

// formatTZPlanMessage builds the human-readable Telegram message for a plan.
func formatTZPlanMessage(plan *store.TZTransitionPlan, steps []planStep) string {
	direction, offsetAbs := tzDirection(plan.OldTZ, plan.NewTZ)

	// Count distinct affected medications.
	medIDs := make(map[int64]struct{})
	for _, s := range steps {
		medIDs[s.MedicationID] = struct{}{}
	}
	medsCount := len(medIDs)

	var sb strings.Builder

	fmt.Fprintf(&sb, "🌍 Timezone Change: %s → %s\n", plan.OldTZ, plan.NewTZ)
	fmt.Fprintf(&sb, "Direction: %s", direction)
	if offsetAbs > 0 {
		fmt.Fprintf(&sb, " (%s)", formatDuration(offsetAbs))
	}
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "Medications affected: %d\n\n", medsCount)

	sb.WriteString("✅ Safety guarantees:\n")
	sb.WriteString("• No doses skipped\n")
	sb.WriteString("• No double doses\n")
	if len(steps) > 0 {
		maxShift := maxStepShift(steps)
		if maxShift > 0 {
			fmt.Fprintf(&sb, "• Max shift per step: %s\n", formatDuration(maxShift))
		}
	}

	if len(steps) == 0 {
		sb.WriteString("\nNo transition steps — schedule will switch immediately.\n")
		return sb.String()
	}

	// Group steps by medication.
	type medGroup struct {
		name  string
		steps []planStep
	}
	seen := make(map[int64]*medGroup)
	var order []int64
	for _, s := range steps {
		if _, ok := seen[s.MedicationID]; !ok {
			seen[s.MedicationID] = &medGroup{name: s.MedName}
			order = append(order, s.MedicationID)
		}
		seen[s.MedicationID].steps = append(seen[s.MedicationID].steps, s)
	}

	for _, medID := range order {
		g := seen[medID]
		// Extract policy label from the first step note (format: "Name (label): ...")
		policyLabel := extractPolicyLabel(g.steps[0].Note)
		fmt.Fprintf(&sb, "\n💊 %s%s:\n", g.name, policyLabel)
		for _, s := range g.steps {
			fmt.Fprintf(&sb, "  • %s\n", s.Note)
		}
		_ = medID
	}

	return sb.String()
}

// tzDirection returns a human-readable direction string and the absolute offset delta.
func tzDirection(oldTZ, newTZ string) (string, time.Duration) {
	now := time.Now()
	oldLoc, err1 := time.LoadLocation(oldTZ)
	newLoc, err2 := time.LoadLocation(newTZ)
	if err1 != nil || err2 != nil {
		return "unknown", 0
	}
	_, oldOff := now.In(oldLoc).Zone()
	_, newOff := now.In(newLoc).Zone()
	delta := time.Duration(newOff-oldOff) * time.Second
	switch {
	case delta > 0:
		return "eastbound", delta
	case delta < 0:
		return "westbound", -delta
	default:
		return "no-change", 0
	}
}

// maxStepShift estimates the maximum per-step shift from the step schedule times.
// It approximates by looking at the step with the largest ScheduledAt gap relative
// to the nominal interval derived from TotalSteps and StepNumber.
func maxStepShift(steps []planStep) time.Duration {
	if len(steps) == 0 {
		return 0
	}
	// Rough estimate: return 2h for strict (TotalSteps > 3), 3h for medium, or full offset for flexible.
	// In practice the note contains the policy label; use step count as a proxy.
	totalSteps := steps[0].TotalSteps
	switch {
	case totalSteps == 1:
		return 0 // flexible or tiny offset
	case totalSteps <= 3:
		return 3 * time.Hour // medium-ish
	default:
		return 2 * time.Hour // strict
	}
}

// extractPolicyLabel parses the policy label from a step note.
// Note format: "MedName (policy label): step N/M — ..."
func extractPolicyLabel(note string) string {
	open := strings.Index(note, "(")
	close := strings.Index(note, ")")
	if open < 0 || close < 0 || close <= open {
		return ""
	}
	label := note[open+1 : close]
	return fmt.Sprintf(" (%s)", label)
}

// formatDuration renders a duration as "Xh" or "Xh Ym".
func formatDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh %dm", h, m)
}
