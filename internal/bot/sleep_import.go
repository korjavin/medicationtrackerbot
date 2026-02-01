package bot

import (
	"archive/zip"
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	_ "modernc.org/sqlite"
)

func (b *Bot) handleDocumentUpload(msg *tgbotapi.Message) {
	// Validate .nxk extension
	if !strings.HasSuffix(strings.ToLower(msg.Document.FileName), ".nxk") {
		b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ Only .nxk files are supported for sleep import."))
		return
	}

	// Validate file size (50MB max to be safe)
	if msg.Document.FileSize > 50*1024*1024 {
		b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ File too large. Maximum size is 50MB."))
		return
	}

	// Send status message
	statusMsg, _ := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "📥 Downloading file..."))

	// Download file from Telegram
	file, err := b.api.GetFile(tgbotapi.FileConfig{FileID: msg.Document.FileID})
	if err != nil {
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
		return
	}

	fileURL := file.Link(b.api.Token)
	tempFile, err := os.CreateTemp("", "sleep-import-*.nxk")
	if err != nil {
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error processing file.")
		return
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	resp, err := http.Get(fileURL)
	if err != nil {
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
		return
	}
	defer resp.Body.Close()

	if _, err := io.Copy(tempFile, resp.Body); err != nil {
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error saving file.")
		return
	}
	tempFile.Close()

	// Import
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "📦 Extracting and importing...")
	imported, skipped, err := b.importSleepFromNXK(tempFile.Name())
	if err != nil {
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, fmt.Sprintf("❌ Import failed: %v", err))
		return
	}

	// Success
	successMsg := fmt.Sprintf("✅ Sleep import complete!\n\n📊 Imported: %d new records\n⏭ Skipped: %d existing records",
		imported, skipped)
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, successMsg)
}

func (b *Bot) importSleepFromNXK(nxkPath string) (int, int, error) {
	// Extract backup.db from ZIP
	zipReader, err := zip.OpenReader(nxkPath)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid ZIP archive: %w", err)
	}
	defer zipReader.Close()

	var dbFile *zip.File
	for _, f := range zipReader.File {
		if f.Name == "backup.db" {
			dbFile = f
			break
		}
	}
	if dbFile == nil {
		return 0, 0, fmt.Errorf("backup.db not found in archive")
	}

	tempDB, err := os.CreateTemp("", "sleep-db-*.db")
	if err != nil {
		return 0, 0, err
	}
	defer os.Remove(tempDB.Name())
	defer tempDB.Close()

	rc, err := dbFile.Open()
	if err != nil {
		return 0, 0, err
	}
	defer rc.Close()

	if _, err := io.Copy(tempDB, rc); err != nil {
		return 0, 0, err
	}
	tempDB.Close()

	// Parse SQLite database
	sleepLogs, err := b.parseSleepDatabase(tempDB.Name())
	if err != nil {
		return 0, 0, err
	}

	if len(sleepLogs) == 0 {
		return 0, 0, fmt.Errorf("no sleep records found")
	}

	// Import
	ctx := context.Background()
	return b.store.ImportSleepLogs(ctx, b.allowedUserID, sleepLogs)
}

func (b *Bot) parseSleepDatabase(dbPath string) ([]store.SleepLog, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT start, end, tz, day, light, deep, rem, awake,
		total, turnOver, hrAvg, spo2Avg, userModified, info FROM sleep ORDER BY start`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []store.SleepLog
	for rows.Next() {
		var startMs, endMs int64
		var tz int
		var day string
		var light, deep, rem, awake, total sql.NullInt64
		var turnOver, hrAvg, spo2Avg sql.NullInt64
		var userModified int
		var info sql.NullString

		err := rows.Scan(&startMs, &endMs, &tz, &day, &light, &deep, &rem,
			&awake, &total, &turnOver, &hrAvg, &spo2Avg, &userModified, &info)
		if err != nil {
			return nil, err
		}

		sl := store.SleepLog{
			StartTime:      time.UnixMilli(startMs).UTC(),
			EndTime:        time.UnixMilli(endMs).UTC(),
			TimezoneOffset: tz,
			Day:            day,
			UserModified:   userModified != 0,
		}

		// Convert nullable integers
		if light.Valid {
			v := int(light.Int64)
			sl.LightMinutes = &v
		}
		if deep.Valid {
			v := int(deep.Int64)
			sl.DeepMinutes = &v
		}
		if rem.Valid {
			v := int(rem.Int64)
			sl.REMMinutes = &v
		}
		if awake.Valid {
			v := int(awake.Int64)
			sl.AwakeMinutes = &v
		}
		if total.Valid {
			v := int(total.Int64)
			sl.TotalMinutes = &v
		}
		if turnOver.Valid {
			v := int(turnOver.Int64)
			sl.TurnOverCount = &v
		}
		if hrAvg.Valid {
			v := int(hrAvg.Int64)
			sl.HeartRateAvg = &v
		}
		if spo2Avg.Valid {
			v := int(spo2Avg.Int64)
			sl.SpO2Avg = &v
		}
		if info.Valid {
			sl.Notes = info.String
		}

		logs = append(logs, sl)
	}

	return logs, nil
}

func (b *Bot) updateStatusMessage(chatID int64, messageID int, text string) {
	edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
	b.api.Send(edit)
}
