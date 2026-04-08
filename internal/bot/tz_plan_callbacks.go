package bot

import (
	"fmt"
	"log/slog"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TZPlanCallbackStore is the subset of store operations needed for timezone plan callbacks.
type TZPlanCallbackStore interface {
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
	SetTZTransitionPlanApproved(id int64, approvedAt time.Time) error
	UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error
}

// handleTZPlanApprove handles the tz_plan_approve:<id> callback.
// It transitions the plan to APPROVED and replies with a brief confirmation.
func (b *Bot) handleTZPlanApprove(cb *tgbotapi.CallbackQuery, planID int64) {
	now := time.Now()
	if err := b.tzPlanStore.SetTZTransitionPlanApproved(planID, now); err != nil {
		slog.Error("tz_plan: approve failed", "plan_id", planID, "error", err)
		b.sendText(cb.Message.Chat.ID, "❌ Could not approve the plan. Please try again.")
		return
	}

	slog.Info("tz_plan: approved", "plan_id", planID, "user_action", "approved", "approved_at", now)

	b.removeAllButtonsFromMessage(cb)
	b.sendText(cb.Message.Chat.ID, fmt.Sprintf("✅ Transition plan #%d approved. Doses will shift as scheduled.", planID))
}

// handleTZPlanReject handles the tz_plan_reject:<id> callback.
// It transitions the plan to REJECTED, logging that the old schedule is retained.
func (b *Bot) handleTZPlanReject(cb *tgbotapi.CallbackQuery, planID int64) {
	if err := b.tzPlanStore.UpdateTZTransitionPlanStatus(planID, "REJECTED", "rejected", ""); err != nil {
		slog.Error("tz_plan: reject failed", "plan_id", planID, "error", err)
		b.sendText(cb.Message.Chat.ID, "❌ Could not reject the plan. Please try again.")
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
