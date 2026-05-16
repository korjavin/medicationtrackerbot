package bot

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// TZPlanCallbackStore is the subset of store operations needed for timezone plan callbacks.
//
// Approval is intentionally not on this interface: it must go through the
// shared tzreschedule.LifecycleService so the plan-approve and pre-materialize
// step inserts share one transaction. See tz_plan_callbacks.go's
// handleTZPlanApprove for the lifecycle-service call site.
type TZPlanCallbackStore interface {
	// RejectTransitionPlanAndRevertTimezone marks the plan REJECTED and reverts
	// the stored timezone back to the plan's OldTZ so the scheduler keeps using the
	// original schedule instead of immediately switching to the new timezone.
	RejectTransitionPlanAndRevertTimezone(id int64) (bool, error)
}

// handleTZPlanApprove handles the tz_plan_approve:<id> callback.
// It routes through the shared tzreschedule.LifecycleService so the plan
// transition to APPROVED and the pre-materialize step inserts share one
// transaction (per CLAUDE.md rule #1 / Track D Task 10).
func (b *Bot) handleTZPlanApprove(cb *tgbotapi.CallbackQuery, planID int64) {
	now := time.Now()
	if b.tzLifecycle == nil {
		slog.Error("tz_plan: approve: lifecycle service not configured", "plan_id", planID)
		b.sendText(cb.Message.Chat.ID, "❌ Could not approve the plan. Please try again.")
		return
	}
	updated, err := b.tzLifecycle.Approve(context.Background(), planID, now)
	if err != nil {
		slog.Error("tz_plan: approve failed", "plan_id", planID, "error", err)
		b.sendText(cb.Message.Chat.ID, "❌ Could not approve the plan. Please try again.")
		return
	}
	if !updated {
		slog.Info("tz_plan: approve ignored (plan no longer pending)", "plan_id", planID)
		b.removeAllButtonsFromMessage(cb)
		b.sendText(cb.Message.Chat.ID, fmt.Sprintf("ℹ️ Transition plan #%d is no longer active.", planID))
		return
	}

	slog.Info("tz_plan: approved", "plan_id", planID, "user_action", "approved", "approved_at", now)

	b.removeAllButtonsFromMessage(cb)
	b.sendText(cb.Message.Chat.ID, fmt.Sprintf("✅ Transition plan #%d approved. Doses will shift as scheduled.", planID))
}

// handleTZPlanReject handles the tz_plan_reject:<id> callback.
// It transitions the plan to REJECTED, logging that the old schedule is retained.
// The update is guarded so that stale callbacks on cancelled or superseded plans are silently ignored.
func (b *Bot) handleTZPlanReject(cb *tgbotapi.CallbackQuery, planID int64) {
	updated, err := b.tzPlanStore.RejectTransitionPlanAndRevertTimezone(planID)
	if err != nil {
		slog.Error("tz_plan: reject failed", "plan_id", planID, "error", err)
		b.sendText(cb.Message.Chat.ID, "❌ Could not reject the plan. Please try again.")
		return
	}
	if !updated {
		slog.Info("tz_plan: reject ignored (plan no longer pending)", "plan_id", planID)
		b.removeAllButtonsFromMessage(cb)
		b.sendText(cb.Message.Chat.ID, fmt.Sprintf("ℹ️ Transition plan #%d is no longer active.", planID))
		return
	}

	slog.Info("tz_plan: rejected", "plan_id", planID, "user_action", "rejected")

	b.removeAllButtonsFromMessage(cb)
	b.sendText(cb.Message.Chat.ID, fmt.Sprintf("🚫 Transition plan #%d rejected. Your old medication schedule is retained.", planID))
}

// sendText sends a plain-text message to the given chat.
func (b *Bot) sendText(chatID int64, text string) {
	if _, err := b.api.Send(tgbotapi.NewMessage(chatID, text)); err != nil {
		slog.Error("send failed", "error", err)
	}
}

// removeAllButtonsFromMessage replaces the inline keyboard with an empty one.
func (b *Bot) removeAllButtonsFromMessage(cb *tgbotapi.CallbackQuery) {
	edit := tgbotapi.NewEditMessageReplyMarkup(
		cb.Message.Chat.ID,
		cb.Message.MessageID,
		tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{}},
	)
	if _, err := b.api.Send(edit); err != nil {
		slog.Error("removeAllButtons: send failed", "error", err)
	}
}
