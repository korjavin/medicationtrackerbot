package bot

import (
	"context"
	"fmt"
	"log/slog"
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

	parsedLog, err := b.foodAI.ParseMealDescription(ctx, args)
	if err != nil {
		slog.Error("food command: meal analysis failed", "chat_id", msg.Chat.ID, "description", args, "error", err)
		msgConfig.Text = "❌ Failed to analyze meal: " + err.Error()
		return
	}

	log := &store.FoodLog{
		UserID:   b.allowedUserID,
		EatenAt:  time.Unix(int64(msg.Date), 0),
		Weight:   parsedLog.Weight,
		Carbs:    parsedLog.Carbs,
		Protein:  parsedLog.Protein,
		Fat:      parsedLog.Fat,
		Calories: parsedLog.Calories,
		Name:     parsedLog.Name,
	}

	_, err = b.food.CreateFoodLog(context.Background(), log)
	if err != nil {
		slog.Error("food command: failed to save food log", "chat_id", msg.Chat.ID, "name", parsedLog.Name, "error", err)
		msgConfig.Text = "❌ Error saving food log to database."
		return
	}

	msgConfig.Text = fmt.Sprintf("✅ Logged %s\n\n📊 Macros: %dg C / %dg P / %dg F\n🔥 Calories: %d kcal\n⚖️ Weight: %dg",
		parsedLog.Name, parsedLog.Carbs, parsedLog.Protein, parsedLog.Fat, parsedLog.Calories, parsedLog.Weight)
}
