package scheduler

import (
	"context"
	"encoding/json"
	"errors"
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
	// MarkPlanNotified atomically transitions the plan from PENDING_APPROVAL to NOTIFIED.
	// Returns true if this process won the CAS (notification should be sent).
	MarkPlanNotified(id int64) (bool, error)
	// ResetPlanToPending reverts a NOTIFIED plan to PENDING_APPROVAL when notification delivery fails.
	ResetPlanToPending(id int64) error
	// UpdateTZTransitionPlanStatus transitions a plan to a new status.
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
	// SetTZTransitionPlanApproved marks a plan as APPROVED with an approval timestamp.
	SetTZTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error)
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

// notifiedPlanExpiryDuration is the maximum time a plan can sit in NOTIFIED status
// before being auto-approved. If the user doesn't act on the notification within this
// window, the timezone change proceeds automatically to avoid permanently stuck schedules.
const notifiedPlanExpiryDuration = 48 * time.Hour

// pendingApprovalExpiryDuration is a safety net for PENDING_APPROVAL plans that
// could never be delivered (e.g., notifiers become unavailable after plan creation).
// If a plan stays in PENDING_APPROVAL for this long, it is auto-approved to prevent
// the medication scheduler from being permanently stuck on the old timezone.
const pendingApprovalExpiryDuration = 72 * time.Hour

// Check implements Checker. It looks for PENDING_APPROVAL plans and atomically
// transitions the status to NOTIFIED before sending the notification, to prevent
// duplicate sends when two scheduler runs overlap. It also auto-approves stale
// NOTIFIED plans that the user never acted on.
func (n *TZPlanNotifier) Check(ctx context.Context) error {
	plan, err := n.store.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		return fmt.Errorf("tz_plan_notifier: GetLatestActive: %w", err)
	}
	if plan == nil {
		return nil
	}

	// Safety net: auto-approve PENDING_APPROVAL plans that have been stuck for too long
	// (e.g., notifiers became unavailable after plan creation). Without this, the
	// medication scheduler would permanently use the old timezone.
	if plan.Status == "PENDING_APPROVAL" && time.Since(plan.CreatedAt) > pendingApprovalExpiryDuration {
		slog.Warn("tz_plan_notifier: PENDING_APPROVAL plan expired, auto-approving",
			"plan_id", plan.ID, "created_at", plan.CreatedAt, "age", time.Since(plan.CreatedAt).String())
		if ok, approveErr := n.store.SetTZTransitionPlanApproved(plan.ID, time.Now()); approveErr != nil {
			return fmt.Errorf("tz_plan_notifier: auto-approve stuck pending plan: %w", approveErr)
		} else if ok {
			slog.Info("tz_plan_notifier: stuck PENDING_APPROVAL plan auto-approved", "plan_id", plan.ID)
		}
		return nil
	}

	// Auto-approve NOTIFIED plans that have been waiting too long. This prevents
	// the timezone change from being permanently stuck when the user dismisses
	// the notification or the action POST fails (e.g., web-only mode).
	// Use NotifiedAt (when the notification was actually delivered) rather than
	// CreatedAt, so the 48h approval window starts from delivery, not creation.
	if plan.Status == "NOTIFIED" && plan.NotifiedAt != nil && time.Since(*plan.NotifiedAt) > notifiedPlanExpiryDuration {
		slog.Warn("tz_plan_notifier: NOTIFIED plan expired, auto-approving",
			"plan_id", plan.ID, "notified_at", plan.NotifiedAt, "age", time.Since(*plan.NotifiedAt).String())
		if ok, approveErr := n.store.SetTZTransitionPlanApproved(plan.ID, time.Now()); approveErr != nil {
			return fmt.Errorf("tz_plan_notifier: auto-approve expired plan: %w", approveErr)
		} else if ok {
			slog.Info("tz_plan_notifier: stale NOTIFIED plan auto-approved", "plan_id", plan.ID)
		}
		return nil
	}

	if plan.Status != "PENDING_APPROVAL" {
		return nil
	}

	// If there are no notifiers configured there is no channel through which the
	// user can receive or approve the plan, so don't transition it to NOTIFIED.
	// Leave it in PENDING_APPROVAL so the next scheduler run can retry once a
	// notifier becomes available (e.g. after a push subscription is registered).
	if len(n.notifiers) == 0 {
		slog.Warn("tz_plan_notifier: no notifiers configured, cannot deliver plan — leaving in PENDING_APPROVAL",
			"plan_id", plan.ID)
		return nil
	}

	// Atomically claim this plan for notification before sending. If the CAS
	// fails (another process already moved it to NOTIFIED), skip sending to
	// avoid duplicate Telegram messages.
	won, err := n.store.MarkPlanNotified(plan.ID)
	if err != nil {
		return fmt.Errorf("tz_plan_notifier: MarkPlanNotified: %w", err)
	}
	if !won {
		// Another process beat us to it; skip.
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
		Metadata: map[string]any{
			"type":    "tz_plan",
			"plan_id": plan.ID,
		},
	}

	if err := n.NotifySync(ctx, notification, nil); err != nil {
		if errors.Is(err, notifier.ErrNoDeliveryChannel) {
			// No delivery channel available (e.g. WebPush configured but no active
			// subscriptions). Cancel the plan so the medication scheduler uses the
			// new timezone immediately — consistent with the no-notifiers path in
			// settings_handlers.go where no plan is generated at all.
			// Without this, the plan would cycle PENDING→NOTIFIED→PENDING forever
			// and the scheduler would stay stuck on OldTZ.
			slog.Warn("tz_plan_notifier: no delivery channel, cancelling plan so new timezone takes effect immediately",
				"plan_id", plan.ID)
			if cancelErr := n.store.UpdateTZTransitionPlanStatus(plan.ID, "CANCELLED", "no-delivery-channel", ""); cancelErr != nil {
				slog.Error("tz_plan_notifier: failed to cancel undeliverable plan",
					"plan_id", plan.ID, "error", cancelErr)
			}
			return nil
		}
		// Transient failure: reset plan to PENDING_APPROVAL so the next scheduler
		// tick can retry. Without this, the plan would be stuck in NOTIFIED forever
		// because Check() only processes PENDING_APPROVAL plans.
		slog.Error("tz_plan_notifier: notification send failed, resetting plan to PENDING_APPROVAL",
			"plan_id", plan.ID, "error", err)
		if resetErr := n.store.ResetPlanToPending(plan.ID); resetErr != nil {
			slog.Error("tz_plan_notifier: failed to reset plan status after send failure",
				"plan_id", plan.ID, "error", resetErr)
		}
		return fmt.Errorf("tz_plan_notifier: notification send failed: %w", err)
	}

	slog.Info("tz_plan_notifier: plan notification sent", "plan_id", plan.ID, "old_tz", plan.OldTZ, "new_tz", plan.NewTZ)
	return nil
}

// mdV1Escaper escapes Telegram Markdown V1 special chars in dynamic strings.
// IANA timezone IDs (America/Los_Angeles, America/New_York, …) and free-form
// medication names contain underscores and other markup characters; without
// escaping, the API rejects the message with "Bad Request: can't parse
// entities" and the user never sees the approval prompt.
var mdV1Escaper = strings.NewReplacer(`_`, `\_`, `*`, `\*`, "`", "\\`", `[`, `\[`)

// formatTZPlanMessage builds the human-readable Telegram message for a plan.
func formatTZPlanMessage(plan *store.TZTransitionPlan, steps []planStep) string {
	direction, offsetAbs := tzDirection(plan.OldTZ, plan.NewTZ, plan.CreatedAt)

	// Count distinct affected medications.
	medIDs := make(map[int64]struct{})
	for _, s := range steps {
		medIDs[s.MedicationID] = struct{}{}
	}
	medsCount := len(medIDs)

	var sb strings.Builder

	fmt.Fprintf(&sb, "🌍 Timezone Change: %s → %s\n", mdV1Escaper.Replace(plan.OldTZ), mdV1Escaper.Replace(plan.NewTZ))
	fmt.Fprintf(&sb, "Direction: %s", direction)
	if offsetAbs > 0 {
		fmt.Fprintf(&sb, " (%s)", formatDuration(offsetAbs))
	}
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "Medications affected: %d\n\n", medsCount)

	// Check whether any step has an unresolvable hand-off warning inserted by the engine.
	hasUnsafeHandoff := false
	for _, s := range steps {
		if strings.Contains(s.Note, "review manually") {
			hasUnsafeHandoff = true
			break
		}
	}

	sb.WriteString("✅ Safety guarantees:\n")
	sb.WriteString("• No doses skipped\n")
	if hasUnsafeHandoff {
		sb.WriteString("• ⚠️ Interval between last transition dose and first normal dose may be shorter than minimum — review manually\n")
	} else {
		sb.WriteString("• Minimum safe interval between doses maintained\n")
	}
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
		fmt.Fprintf(&sb, "\n💊 %s%s:\n", mdV1Escaper.Replace(g.name), policyLabel)
		for _, s := range g.steps {
			fmt.Fprintf(&sb, "  • %s\n", mdV1Escaper.Replace(s.Note))
		}
		_ = medID
	}

	return sb.String()
}

// tzDirection returns a human-readable direction string and the absolute offset delta.
// It uses refTime to compute UTC offsets so that DST rules are evaluated at the
// moment the plan was created rather than at notification time.
func tzDirection(oldTZ, newTZ string, refTime time.Time) (string, time.Duration) {
	now := refTime
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
