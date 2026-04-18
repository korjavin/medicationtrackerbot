package bot

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// handleIntakeCommand handles the /intake command
// Format: /intake <carbs> <protein> <fat> <weight> [name]
// Assumes macros are per 100g
func (b *Bot) handleIntakeCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	// Check if feature is enabled
	enabled, err := b.food.GetFoodIntakeEnabled(context.Background())
	if err != nil {
		msgConfig.Text = "❌ Error checking settings."
		return
	}
	if !enabled {
		msgConfig.Text = "⚠️ Food intake tracking is disabled in settings."
		return
	}

	args := msg.CommandArguments()
	if args == "" {
		msgConfig.Text = `**Food Intake Logging**

Usage: /intake <carbs> <protein> <fat> <weight> [name]
(Macros are per 100g)

Example:
  /intake 23 12 10 150 Vinegret
  (23g Carbs, 12g Protein, 10g Fat per 100g. Ate 150g.)`
		msgConfig.ParseMode = "Markdown"
		return
	}

	parsed, err := domain.ParseIntakeArgs(args)
	if err != nil {
		msgConfig.Text = "❌ " + err.Error()
		return
	}

	totalCarbs, totalProt, totalFat, totalCals := domain.CalculateMacros(parsed.Carbs100, parsed.Prot100, parsed.Fat100, parsed.Weight)

	log := &store.FoodLog{
		UserID:   b.allowedUserID,
		EatenAt:  time.Unix(int64(msg.Date), 0),
		Weight:   int(parsed.Weight),
		Carbs:    totalCarbs,
		Protein:  totalProt,
		Fat:      totalFat,
		Calories: totalCals,
		Name:     parsed.Name,
	}

	_, err = b.food.CreateFoodLog(context.Background(), log)
	if err != nil {
		msgConfig.Text = "❌ Error saving food log."
		return
	}

	msgConfig.Text = fmt.Sprintf("✅ Logged %s\n\n📊 Macros: %dg C / %dg P / %dg F\n🔥 Calories: %d kcal\n⚖️ Weight: %dg",
		parsed.Name, totalCarbs, totalProt, totalFat, totalCals, int(parsed.Weight))
}

// handleFoodCommand handles the /food command using natural language and the AI service
func (b *Bot) handleFoodCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	// Check if feature is enabled
	enabled, err := b.food.GetFoodIntakeEnabled(context.Background())
	if err != nil {
		msgConfig.Text = "❌ Error checking settings."
		return
	}
	if !enabled {
		msgConfig.Text = "⚠️ Food intake tracking is disabled in settings."
		return
	}

	if b.foodAI == nil {
		msgConfig.Text = "⚠️ AI food logging is not configured. Missing OPENAI environment variables."
		return
	}

	args := msg.CommandArguments()
	if args == "" {
		msgConfig.Text = `**AI Food Logging**

Usage: /food <description>

Examples:
  /food 200g chicken breast with a cup of rice
  /food Big Mac meal with medium fries and diet coke`
		msgConfig.ParseMode = "Markdown"
		return
	}

	// Tell the user we are processing...
	processingMsg := tgbotapi.NewMessage(msg.Chat.ID, "⏳ Analyzing your meal...")
	sentMsg, err := b.api.Send(processingMsg)
	if err != nil {
		slog.Warn("food command: failed to send processing message", "chat_id", msg.Chat.ID, "error", err)
	}

	// Delete processing message eventually
	defer func() {
		if sentMsg.MessageID != 0 {
			if _, err := b.api.Request(tgbotapi.NewDeleteMessage(msg.Chat.ID, sentMsg.MessageID)); err != nil {
				slog.Warn("food command: failed to delete processing message", "chat_id", msg.Chat.ID, "message_id", sentMsg.MessageID, "error", err)
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	parsedLogs, err := b.foodAI.ParseMealDescription(ctx, args)
	if err != nil {
		slog.Error("food command: meal analysis failed", "chat_id", msg.Chat.ID, "description", args, "error", err)
		msgConfig.Text = "❌ Failed to analyze meal: " + err.Error()
		return
	}

	if len(parsedLogs) == 0 {
		msgConfig.Text = "❌ AI returned no meal items."
		return
	}

	eatenAt := time.Unix(int64(msg.Date), 0)
	saveCtx, saveCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer saveCancel()

	saved := make([]domain.FoodLog, 0, len(parsedLogs))
	var failed int
	for _, item := range parsedLogs {
		entry := &store.FoodLog{
			UserID:   b.allowedUserID,
			EatenAt:  eatenAt,
			Weight:   item.Weight,
			Carbs:    item.Carbs,
			Protein:  item.Protein,
			Fat:      item.Fat,
			Calories: item.Calories,
			Name:     item.Name,
		}
		if _, err := b.food.CreateFoodLog(saveCtx, entry); err != nil {
			slog.Error("food command: failed to save food log", "chat_id", msg.Chat.ID, "name", item.Name, "error", err)
			failed++
			continue
		}
		saved = append(saved, item)
	}

	if len(saved) == 0 {
		msgConfig.Text = "❌ Error saving food log to database."
		return
	}

	msgConfig.Text = renderFoodSummary(saved, failed)
}

// telegramMessageLimit is the safe threshold for a single Telegram message.
// The hard cap is 4096 UTF-16 code units; we leave a buffer for emoji and the
// truncation marker.
const telegramMessageLimit = 3900

// renderFoodSummary builds the reply shown after the /food command persists items.
// saved is the list of successfully stored items; failed is the count of items that errored.
// If the full reply would exceed Telegram's message-length limit, the per-item
// list is truncated and an "… and N more items" marker is inserted so the
// aggregate totals always remain visible.
func renderFoodSummary(saved []domain.FoodLog, failed int) string {
	var totalCarbs, totalProtein, totalFat, totalCals, totalWeight int
	for _, item := range saved {
		totalCarbs += item.Carbs
		totalProtein += item.Protein
		totalFat += item.Fat
		totalCals += item.Calories
		totalWeight += item.Weight
	}

	var header string
	if failed > 0 {
		header = fmt.Sprintf("⚠️ Logged %d of %d items; %d failed to save\n\n", len(saved), len(saved)+failed, failed)
	} else {
		plural := ""
		if len(saved) != 1 {
			plural = "s"
		}
		header = fmt.Sprintf("✅ Logged %d item%s\n\n", len(saved), plural)
	}
	footer := fmt.Sprintf("\n📊 Total: %dg C / %dg P / %dg F\n🔥 Calories: %d kcal\n⚖️ Weight: %dg",
		totalCarbs, totalProtein, totalFat, totalCals, totalWeight)

	var body strings.Builder
	body.WriteString(header)
	for i, item := range saved {
		line := fmt.Sprintf("• %s (%dg) — %dg C / %dg P / %dg F · %d kcal\n",
			item.Name, item.Weight, item.Carbs, item.Protein, item.Fat, item.Calories)
		remaining := len(saved) - i
		truncMarker := fmt.Sprintf("… and %d more items\n", remaining)
		// Check whether appending this line still leaves room for either the
		// footer or (if more items remain) a truncation marker + footer.
		projected := body.Len() + len(line) + len(footer)
		if remaining > 1 {
			projected += len(truncMarker)
		}
		if projected > telegramMessageLimit {
			body.WriteString(truncMarker)
			break
		}
		body.WriteString(line)
	}
	body.WriteString(footer)
	return body.String()
}
