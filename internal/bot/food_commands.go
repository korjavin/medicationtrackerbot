package bot

import (
	"context"
	"fmt"
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
