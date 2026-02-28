package bot

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
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

	parts := strings.Fields(args)
	if len(parts) < 4 {
		msgConfig.Text = "❌ Invalid format. Need at least 4 numbers: carbs protein fat weight"
		return
	}

	// Parse numbers
	carbs100, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		msgConfig.Text = "❌ Invalid carbs value"
		return
	}
	prot100, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		msgConfig.Text = "❌ Invalid protein value"
		return
	}
	fat100, err := strconv.ParseFloat(parts[2], 64)
	if err != nil {
		msgConfig.Text = "❌ Invalid fat value"
		return
	}
	weight, err := strconv.ParseFloat(parts[3], 64)
	if err != nil {
		msgConfig.Text = "❌ Invalid weight value"
		return
	}

	// Calculate totals
	totalCarbs := int((carbs100 * weight) / 100)
	totalProt := int((prot100 * weight) / 100)
	totalFat := int((fat100 * weight) / 100)
	totalCals := (4 * totalCarbs) + (4 * totalProt) + (9 * totalFat)

	// Name
	name := "Food"
	if len(parts) > 4 {
		name = strings.Join(parts[4:], " ")
	}

	log := &store.FoodLog{
		UserID:   b.allowedUserID,
		EatenAt:  time.Unix(int64(msg.Date), 0),
		Weight:   int(weight),
		Carbs:    totalCarbs,
		Protein:  totalProt,
		Fat:      totalFat,
		Calories: totalCals,
		Name:     name,
	}

	_, err = b.food.CreateFoodLog(context.Background(), log)
	if err != nil {
		msgConfig.Text = "❌ Error saving food log."
		return
	}

	msgConfig.Text = fmt.Sprintf("✅ Logged %s\n\n📊 Macros: %dg C / %dg P / %dg F\n🔥 Calories: %d kcal\n⚖️ Weight: %dg",
		name, totalCarbs, totalProt, totalFat, totalCals, int(weight))
}
