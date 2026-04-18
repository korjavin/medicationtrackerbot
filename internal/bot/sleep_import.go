package bot

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (b *Bot) handleDocumentUpload(msg *tgbotapi.Message) {
	slog.Info("Document upload received", "fileName", msg.Document.FileName, "size", msg.Document.FileSize)

	if err := domain.ValidateImportFile(msg.Document.FileName, int64(msg.Document.FileSize)); err != nil {
		slog.Warn("Import file validation failed", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ "+err.Error())); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Send status message
	statusMsg, _ := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "📥 Downloading file..."))

	// Get file info from Telegram
	file, err := b.api.GetFile(tgbotapi.FileConfig{FileID: msg.Document.FileID})
	if err != nil {
		slog.Error("Error getting file from Telegram API", "error", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
		return
	}

	ext := ""
	if msg.Document.FileName != "" {
		ext = filepath.Ext(msg.Document.FileName)
	}
	tempFile, err := os.CreateTemp("", "sleep-import-*"+ext)
	if err != nil {
		slog.Error("Error creating temp file", "error", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error processing file.")
		return
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	// Check if using local Bot API (file path starts with /)
	if strings.HasPrefix(file.FilePath, "/") {
		// Local mode - file is already on shared volume, copy it directly
		slog.Info("Using local file", "filePath", file.FilePath)
		sourceFile, err := os.Open(file.FilePath)
		if err != nil {
			slog.Error("Error opening local file", "filePath", file.FilePath, "error", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error accessing file.")
			return
		}
		defer sourceFile.Close()

		written, err := io.Copy(tempFile, sourceFile)
		if err != nil {
			slog.Error("Error copying local file", "error", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error reading file.")
			return
		}
		slog.Info("File copied from local storage", "bytesWritten", written, "destPath", tempFile.Name())
	} else {
		// Remote mode - download via HTTP
		fileURL := file.Link(b.api.Token)
		slog.Info("Downloading file", "url", fileURL)

		resp, err := b.httpClient.Get(fileURL) // #nosec G107 -- fileURL is from Telegram Bot API (file.Link), not user-controlled, and we use a pre-configured timeout client
		if err != nil {
			slog.Error("Error downloading file", "url", fileURL, "error", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			slog.Error("Bad HTTP status downloading file", "statusCode", resp.StatusCode, "status", resp.Status)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
			return
		}

		written, err := io.Copy(tempFile, resp.Body)
		if err != nil {
			slog.Error("Error saving file to disk", "error", err)
			b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error saving file.")
			return
		}
		slog.Info("File downloaded successfully", "bytesWritten", written, "destPath", tempFile.Name())
	}
	_ = tempFile.Close()

	// Import
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "📦 Extracting and importing...")
	imported, skipped, err := b.importSleepFile(tempFile.Name())
	if err != nil {
		slog.Error("Sleep import failed", "error", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, fmt.Sprintf("❌ Import failed: %v", err))
		return
	}

	// Success
	slog.Info("Sleep/Vitals import successful", "imported", imported, "skipped", skipped)
	successMsg := fmt.Sprintf("✅ Import complete!\n\n📊 Imported: %d new records\n⏭ Skipped: %d existing records",
		imported, skipped)
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, successMsg)
}

func (b *Bot) importSleepFile(filePath string) (int, int, error) {
	slog.Info("Starting sleep import from file", "path", filePath)

	dbPath, cleanup, err := domain.PrepareBackupDB(filePath)
	if err != nil {
		slog.Error("Failed to prepare backup DB", "error", err)
		return 0, 0, err
	}
	defer cleanup()

	// Parse SQLite database
	domainSleepLogs, err := domain.ParseSleepDatabase(dbPath)
	if err != nil {
		slog.Error("Failed to parse sleep database", "error", err)
		return 0, 0, err
	}

	if len(domainSleepLogs) == 0 {
		slog.Info("No sleep records found in database")
		return 0, 0, fmt.Errorf("no sleep records found")
	}

	slog.Info("Parsed sleep records from database", "count", len(domainSleepLogs))

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
		slog.Error("Failed to import sleep logs to database", "error", err)
		return 0, 0, err
	}

	// Parse and import vitals
	domainHeartLogs, err := domain.ParseHeartDatabase(dbPath)
	if err != nil {
		slog.Warn("Failed to parse heart database", "error", err)
	}
	heartLogs := make([]store.VitalsHeartLog, len(domainHeartLogs))
	for i, h := range domainHeartLogs {
		heartLogs[i] = store.VitalsHeartLog{DateTime: h.DateTime, TzOffset: h.TzOffset, Value: h.Value, Type: h.Type}
	}

	domainSpo2Logs, err := domain.ParseSpO2Database(dbPath)
	if err != nil {
		slog.Warn("Failed to parse spo2 database", "error", err)
	}
	spo2Logs := make([]store.VitalsSpO2Log, len(domainSpo2Logs))
	for i, s := range domainSpo2Logs {
		spo2Logs[i] = store.VitalsSpO2Log{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type}
	}

	domainStressLogs, err := domain.ParseStressDatabase(dbPath)
	if err != nil {
		slog.Warn("Failed to parse stress database", "error", err)
	}
	stressLogs := make([]store.VitalsStressLog, len(domainStressLogs))
	for i, s := range domainStressLogs {
		stressLogs[i] = store.VitalsStressLog{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type, Info: s.Info}
	}

	vitalsImported, vitalsSkipped, err := b.imports.ImportVitals(ctx, b.allowedUserID, heartLogs, spo2Logs, stressLogs)
	if err != nil {
		slog.Error("Failed to import vitals logs to database", "error", err)
	} else {
		slog.Info("Successfully imported vitals records", "imported", vitalsImported, "skipped", vitalsSkipped)
	}

	// Parse and import day stats
	domainDayStats, err := domain.ParseDayDatabase(dbPath)
	if err != nil {
		slog.Warn("Failed to parse day database", "error", err)
	}
	dayStats := make([]store.DayStat, len(domainDayStats))
	for i, d := range domainDayStats {
		dayStats[i] = store.DayStat{Day: d.Day, Steps: d.Steps, Calories: d.Calories, Distance: d.Distance}
	}

	statsImported, statsSkipped, err := b.imports.ImportDayStats(ctx, b.allowedUserID, dayStats)
	if err != nil {
		slog.Error("Failed to import day stats to database", "error", err)
	} else {
		slog.Info("Successfully imported day stats", "imported", statsImported, "skipped", statsSkipped)
	}

	// Parse and import Mi Band outdoor workouts
	domainWorkouts, domainGPS, err := domain.ParseOutdoorWorkouts(dbPath)
	if err != nil {
		slog.Warn("Failed to parse outdoor workouts", "error", err)
	}
	wImported, wSkipped := 0, 0
	if len(domainWorkouts) > 0 {
		storeWorkouts := make([]store.MiBandWorkout, len(domainWorkouts))
		for i, w := range domainWorkouts {
			storeWorkouts[i] = store.MiBandWorkout{
				UserID:        b.allowedUserID,
				SourceStartMs: w.SourceStartMs,
				SourceEndMs:   w.SourceEndMs,
				ActivityType:  w.ActivityType,
				ActivityName:  w.ActivityName,
				DurationSec:   w.DurationSec,
				DistanceM:     w.DistanceM,
				Steps:         w.Steps,
				Calories:      w.Calories,
				HeartRateAvg:  w.HeartRateAvg,
				SpO2Avg:       w.SpO2Avg,
				PauseMs:       w.PauseMs,
				TzOffset:      w.TzOffset,
			}
		}
		// Convert domain GPS tracks to store GPS tracks
		storeGPS := make(map[int64][]store.MiBandGPSPoint, len(domainGPS))
		for startMs, pts := range domainGPS {
			storePts := make([]store.MiBandGPSPoint, len(pts))
			for i, pt := range pts {
				storePts[i] = store.MiBandGPSPoint{
					TsMs:      pt.TsMs,
					Latitude:  pt.Latitude,
					Longitude: pt.Longitude,
					Altitude:  pt.Altitude,
					IsPause:   pt.IsPause,
				}
			}
			storeGPS[startMs] = storePts
		}
		wImported, wSkipped, err = b.imports.ImportMiBandWorkouts(ctx, storeWorkouts, storeGPS)
		if err != nil {
			slog.Error("Failed to import Mi Band workouts", "error", err)
		} else {
			slog.Info("Successfully imported Mi Band workouts", "imported", wImported, "skipped", wSkipped)
		}
	}

	return imported + vitalsImported + statsImported + wImported,
		skipped + vitalsSkipped + statsSkipped + wSkipped, nil
}

func (b *Bot) updateStatusMessage(chatID int64, messageID int, text string) {
	edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
	if _, err := b.api.Send(edit); err != nil {
		slog.Error("send failed", "error", err)
	}
}
