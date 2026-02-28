package bot

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (b *Bot) handleDocumentUpload(msg *tgbotapi.Message) {
	log.Printf("Document upload received: %s (size: %d bytes)", msg.Document.FileName, msg.Document.FileSize)

	if err := domain.ValidateImportFile(msg.Document.FileName, int64(msg.Document.FileSize)); err != nil {
		log.Printf("Import file validation failed: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ "+err.Error())); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Send status message
	statusMsg, _ := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "📥 Downloading file..."))

	// Get file info from Telegram
	file, err := b.api.GetFile(tgbotapi.FileConfig{FileID: msg.Document.FileID})
	if err != nil {
		log.Printf("Error getting file from Telegram API: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
		return
	}

	tempFile, err := os.CreateTemp("", "sleep-import-*.nxk")
	if err != nil {
		log.Printf("Error creating temp file: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error processing file.")
		return
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	// Check if using local Bot API (file path starts with /)
	if strings.HasPrefix(file.FilePath, "/") {
		// Local mode - file is already on shared volume, copy it directly
		log.Printf("Using local file: %s", file.FilePath)
		sourceFile, err := os.Open(file.FilePath)
		if err != nil {
			log.Printf("Error opening local file %s: %v", file.FilePath, err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error accessing file.")
			return
		}
		defer sourceFile.Close()

		written, err := io.Copy(tempFile, sourceFile)
		if err != nil {
			log.Printf("Error copying local file: %v", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error reading file.")
			return
		}
		log.Printf("File copied from local storage: %d bytes written to %s", written, tempFile.Name())
	} else {
		// Remote mode - download via HTTP
		fileURL := file.Link(b.api.Token)
		log.Printf("Downloading file from: %s", fileURL)

		resp, err := http.Get(fileURL) // #nosec G107 -- fileURL is from Telegram Bot API (file.Link), not user-controlled
		if err != nil {
			log.Printf("Error downloading file from URL %s: %v", fileURL, err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			log.Printf("Bad HTTP status downloading file: %d %s", resp.StatusCode, resp.Status)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
			return
		}

		written, err := io.Copy(tempFile, resp.Body)
		if err != nil {
			log.Printf("Error saving file to disk: %v", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error saving file.")
			return
		}
		log.Printf("File downloaded successfully: %d bytes written to %s", written, tempFile.Name())
	}
	_ = tempFile.Close()

	// Import
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "📦 Extracting and importing...")
	imported, skipped, err := b.importSleepFromNXK(tempFile.Name())
	if err != nil {
		log.Printf("Sleep import failed: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, fmt.Sprintf("❌ Import failed: %v", err))
		return
	}

	// Success
	log.Printf("Sleep/Vitals import successful: %d imported, %d skipped", imported, skipped)
	successMsg := fmt.Sprintf("✅ Import complete!\n\n📊 Imported: %d new records\n⏭ Skipped: %d existing records",
		imported, skipped)
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, successMsg)
}

func (b *Bot) importSleepFromNXK(nxkPath string) (int, int, error) {
	log.Printf("Starting sleep import from NXK file: %s", nxkPath)

	dbPath, cleanup, err := domain.ExtractBackupDB(nxkPath)
	if err != nil {
		log.Printf("Failed to extract backup.db: %v", err)
		return 0, 0, err
	}
	defer cleanup()

	// Parse SQLite database
	domainSleepLogs, err := domain.ParseSleepDatabase(dbPath)
	if err != nil {
		log.Printf("Failed to parse sleep database: %v", err)
		return 0, 0, err
	}

	if len(domainSleepLogs) == 0 {
		log.Printf("No sleep records found in database")
		return 0, 0, fmt.Errorf("no sleep records found")
	}

	log.Printf("Parsed %d sleep records from database", len(domainSleepLogs))

	// Convert domain types to store types
	sleepLogs := make([]store.SleepLog, len(domainSleepLogs))
	for i, sl := range domainSleepLogs {
		sleepLogs[i] = store.SleepLog{
			StartTime: sl.StartTime, EndTime: sl.EndTime,
			TimezoneOffset: sl.TimezoneOffset, Day: sl.Day,
			LightMinutes: sl.LightMinutes, DeepMinutes: sl.DeepMinutes,
			REMMinutes: sl.REMMinutes, AwakeMinutes: sl.AwakeMinutes,
			TotalMinutes: sl.TotalMinutes, TurnOverCount: sl.TurnOverCount,
			HeartRateAvg: sl.HeartRateAvg, SpO2Avg: sl.SpO2Avg,
			UserModified: sl.UserModified, Notes: sl.Notes,
		}
	}

	// Import sleep
	ctx := context.Background()
	imported, skipped, err := b.imports.ImportSleepLogs(ctx, b.allowedUserID, sleepLogs)
	if err != nil {
		log.Printf("Failed to import sleep logs to database: %v", err)
		return 0, 0, err
	}

	// Parse and import vitals
	domainHeartLogs, err := domain.ParseHeartDatabase(dbPath)
	if err != nil {
		log.Printf("Failed to parse heart database: %v", err)
	}
	heartLogs := make([]store.VitalsHeartLog, len(domainHeartLogs))
	for i, h := range domainHeartLogs {
		heartLogs[i] = store.VitalsHeartLog{DateTime: h.DateTime, TzOffset: h.TzOffset, Value: h.Value, Type: h.Type}
	}

	domainSpo2Logs, err := domain.ParseSpO2Database(dbPath)
	if err != nil {
		log.Printf("Failed to parse spo2 database: %v", err)
	}
	spo2Logs := make([]store.VitalsSpO2Log, len(domainSpo2Logs))
	for i, s := range domainSpo2Logs {
		spo2Logs[i] = store.VitalsSpO2Log{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type}
	}

	domainStressLogs, err := domain.ParseStressDatabase(dbPath)
	if err != nil {
		log.Printf("Failed to parse stress database: %v", err)
	}
	stressLogs := make([]store.VitalsStressLog, len(domainStressLogs))
	for i, s := range domainStressLogs {
		stressLogs[i] = store.VitalsStressLog{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type, Info: s.Info}
	}

	vitalsImported, vitalsSkipped, err := b.imports.ImportVitals(ctx, b.allowedUserID, heartLogs, spo2Logs, stressLogs)
	if err != nil {
		log.Printf("Failed to import vitals logs to database: %v", err)
	} else {
		log.Printf("Successfully imported %d vitals records, skipped %d", vitalsImported, vitalsSkipped)
	}

	// Parse and import day stats
	domainDayStats, err := domain.ParseDayDatabase(dbPath)
	if err != nil {
		log.Printf("Failed to parse day database: %v", err)
	}
	dayStats := make([]store.DayStat, len(domainDayStats))
	for i, d := range domainDayStats {
		dayStats[i] = store.DayStat{Day: d.Day, Steps: d.Steps, Calories: d.Calories, Distance: d.Distance}
	}

	statsImported, statsSkipped, err := b.imports.ImportDayStats(ctx, b.allowedUserID, dayStats)
	if err != nil {
		log.Printf("Failed to import day stats to database: %v", err)
	} else {
		log.Printf("Successfully imported %d day stats, skipped %d", statsImported, statsSkipped)
	}

	return imported + vitalsImported + statsImported, skipped + vitalsSkipped + statsSkipped, nil
}

func (b *Bot) updateStatusMessage(chatID int64, messageID int, text string) {
	edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
	if _, err := b.api.Send(edit); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}
}
