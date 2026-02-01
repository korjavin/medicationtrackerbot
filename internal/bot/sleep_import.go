package bot

import (
	"archive/zip"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	_ "modernc.org/sqlite"
)

func (b *Bot) handleDocumentUpload(msg *tgbotapi.Message) {
	log.Printf("Document upload received: %s (size: %d bytes)", msg.Document.FileName, msg.Document.FileSize)

	// Validate .nxk extension
	if !strings.HasSuffix(strings.ToLower(msg.Document.FileName), ".nxk") {
		log.Printf("Invalid file extension for sleep import: %s", msg.Document.FileName)
		b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ Only .nxk files are supported for sleep import."))
		return
	}

	// Validate file size (50MB max to be safe)
	if msg.Document.FileSize > 50*1024*1024 {
		log.Printf("File too large for sleep import: %d bytes", msg.Document.FileSize)
		b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ File too large. Maximum size is 50MB."))
		return
	}

	// Send status message
	statusMsg, _ := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "📥 Downloading file..."))

	// Download file from Telegram
	file, err := b.api.GetFile(tgbotapi.FileConfig{FileID: msg.Document.FileID})
	if err != nil {
		log.Printf("Error getting file from Telegram API: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error downloading file.")
		return
	}

	fileURL := file.Link(b.api.Token)
	log.Printf("Downloading file from: %s", fileURL)

	tempFile, err := os.CreateTemp("", "sleep-import-*.nxk")
	if err != nil {
		log.Printf("Error creating temp file: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "❌ Error processing file.")
		return
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	resp, err := http.Get(fileURL)
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
	tempFile.Close()
	log.Printf("File downloaded successfully: %d bytes written to %s", written, tempFile.Name())

	// Import
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, "📦 Extracting and importing...")
	imported, skipped, err := b.importSleepFromNXK(tempFile.Name())
	if err != nil {
		log.Printf("Sleep import failed: %v", err)
		b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, fmt.Sprintf("❌ Import failed: %v", err))
		return
	}

	// Success
	log.Printf("Sleep import successful: %d imported, %d skipped", imported, skipped)
	successMsg := fmt.Sprintf("✅ Sleep import complete!\n\n📊 Imported: %d new records\n⏭ Skipped: %d existing records",
		imported, skipped)
	b.updateStatusMessage(msg.Chat.ID, statusMsg.MessageID, successMsg)
}

func (b *Bot) importSleepFromNXK(nxkPath string) (int, int, error) {
	log.Printf("Starting sleep import from NXK file: %s", nxkPath)

	// Extract backup.db from ZIP
	zipReader, err := zip.OpenReader(nxkPath)
	if err != nil {
		log.Printf("Failed to open ZIP archive: %v", err)
		return 0, 0, fmt.Errorf("invalid ZIP archive: %w", err)
	}
	defer zipReader.Close()

	log.Printf("ZIP archive opened, searching for backup.db among %d files", len(zipReader.File))
	var dbFile *zip.File
	for _, f := range zipReader.File {
		log.Printf("Found file in archive: %s", f.Name)
		if f.Name == "backup.db" {
			dbFile = f
			break
		}
	}
	if dbFile == nil {
		log.Printf("backup.db not found in archive")
		return 0, 0, fmt.Errorf("backup.db not found in archive")
	}

	log.Printf("Found backup.db in archive (size: %d bytes)", dbFile.UncompressedSize64)

	tempDB, err := os.CreateTemp("", "sleep-db-*.db")
	if err != nil {
		log.Printf("Failed to create temp DB file: %v", err)
		return 0, 0, err
	}
	defer os.Remove(tempDB.Name())
	defer tempDB.Close()

	rc, err := dbFile.Open()
	if err != nil {
		log.Printf("Failed to open backup.db from archive: %v", err)
		return 0, 0, err
	}
	defer rc.Close()

	written, err := io.Copy(tempDB, rc)
	if err != nil {
		log.Printf("Failed to extract backup.db: %v", err)
		return 0, 0, err
	}
	tempDB.Close()
	log.Printf("Extracted backup.db: %d bytes written to %s", written, tempDB.Name())

	// Parse SQLite database
	sleepLogs, err := b.parseSleepDatabase(tempDB.Name())
	if err != nil {
		log.Printf("Failed to parse sleep database: %v", err)
		return 0, 0, err
	}

	if len(sleepLogs) == 0 {
		log.Printf("No sleep records found in database")
		return 0, 0, fmt.Errorf("no sleep records found")
	}

	log.Printf("Parsed %d sleep records from database", len(sleepLogs))

	// Import
	ctx := context.Background()
	imported, skipped, err := b.store.ImportSleepLogs(ctx, b.allowedUserID, sleepLogs)
	if err != nil {
		log.Printf("Failed to import sleep logs to database: %v", err)
		return 0, 0, err
	}

	return imported, skipped, nil
}

func (b *Bot) parseSleepDatabase(dbPath string) ([]store.SleepLog, error) {
	log.Printf("Parsing sleep database: %s", dbPath)

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Printf("Failed to open SQLite database: %v", err)
		return nil, err
	}
	defer db.Close()

	// Test connection
	if err := db.Ping(); err != nil {
		log.Printf("Failed to ping SQLite database: %v", err)
		return nil, fmt.Errorf("invalid database file: %w", err)
	}

	rows, err := db.Query(`SELECT start, end, tz, day, light, deep, rem, awake,
		total, turnOver, hrAvg, spo2Avg, userModified, info FROM sleep ORDER BY start`)
	if err != nil {
		log.Printf("Failed to query sleep table: %v", err)
		return nil, fmt.Errorf("failed to query sleep table: %w", err)
	}
	defer rows.Close()

	var logs []store.SleepLog
	recordCount := 0
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
			log.Printf("Failed to scan row %d: %v", recordCount+1, err)
			return nil, fmt.Errorf("failed to scan sleep record: %w", err)
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
		recordCount++
	}

	if err := rows.Err(); err != nil {
		log.Printf("Error iterating over rows: %v", err)
		return nil, fmt.Errorf("error reading sleep records: %w", err)
	}

	log.Printf("Successfully parsed %d sleep records", recordCount)
	return logs, nil
}

func (b *Bot) updateStatusMessage(chatID int64, messageID int, text string) {
	edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
	b.api.Send(edit)
}
