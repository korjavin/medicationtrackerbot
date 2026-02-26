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
		if _, err := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ Only .nxk files are supported for sleep import.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Validate file size (50MB max to be safe)
	if msg.Document.FileSize > 50*1024*1024 {
		log.Printf("File too large for sleep import: %d bytes", msg.Document.FileSize)
		if _, err := b.api.Send(tgbotapi.NewMessage(msg.Chat.ID, "⚠️ File too large. Maximum size is 50MB.")); err != nil {
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

	const maxSleepDBSize = 256 * 1024 * 1024 // 256 MB
	written, err := io.Copy(tempDB, io.LimitReader(rc, maxSleepDBSize))
	if err != nil {
		log.Printf("Failed to extract backup.db: %v", err)
		return 0, 0, err
	}
	_ = tempDB.Close()
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

	// Import sleep
	ctx := context.Background()
	imported, skipped, err := b.store.ImportSleepLogs(ctx, b.allowedUserID, sleepLogs)
	if err != nil {
		log.Printf("Failed to import sleep logs to database: %v", err)
		return 0, 0, err
	}

	// Parse and import vitals
	heartLogs, err := b.parseHeartDatabase(tempDB.Name())
	if err != nil {
		log.Printf("Failed to parse heart database: %v", err)
	}

	spo2Logs, err := b.parseSpO2Database(tempDB.Name())
	if err != nil {
		log.Printf("Failed to parse spo2 database: %v", err)
	}

	stressLogs, err := b.parseStressDatabase(tempDB.Name())
	if err != nil {
		log.Printf("Failed to parse stress database: %v", err)
	}

	vitalsImported, vitalsSkipped, err := b.store.ImportVitals(ctx, b.allowedUserID, heartLogs, spo2Logs, stressLogs)
	if err != nil {
		log.Printf("Failed to import vitals logs to database: %v", err)
		// We don't return here because we already imported sleep logs
	} else {
		log.Printf("Successfully imported %d vitals records, skipped %d", vitalsImported, vitalsSkipped)
	}

	// Parse and import day stats
	dayStats, err := b.parseDayDatabase(tempDB.Name())
	if err != nil {
		log.Printf("Failed to parse day database: %v", err)
	}

	statsImported, statsSkipped, err := b.store.ImportDayStats(ctx, b.allowedUserID, dayStats)
	if err != nil {
		log.Printf("Failed to import day stats to database: %v", err)
	} else {
		log.Printf("Successfully imported %d day stats, skipped %d", statsImported, statsSkipped)
	}

	return imported + vitalsImported + statsImported, skipped + vitalsSkipped + statsSkipped, nil
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

func (b *Bot) parseHeartDatabase(dbPath string) ([]store.VitalsHeartLog, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type FROM heart ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []store.VitalsHeartLog
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		if err := rows.Scan(&dateMs, &tz, &val, &typ); err != nil {
			return nil, err
		}
		logs = append(logs, store.VitalsHeartLog{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		})
	}
	return logs, nil
}

func (b *Bot) parseDayDatabase(dbPath string) ([]store.DayStat, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT day, steps, calories, distance FROM day ORDER BY day`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []store.DayStat
	for rows.Next() {
		var dayStr string
		var steps, cal, dist int
		if err := rows.Scan(&dayStr, &steps, &cal, &dist); err != nil {
			return nil, err
		}
		stats = append(stats, store.DayStat{
			Day:      dayStr,
			Steps:    steps,
			Calories: cal,
			Distance: dist,
		})
	}
	return stats, nil
}

func (b *Bot) parseSpO2Database(dbPath string) ([]store.VitalsSpO2Log, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type FROM spo2 ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []store.VitalsSpO2Log
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		if err := rows.Scan(&dateMs, &tz, &val, &typ); err != nil {
			return nil, err
		}
		logs = append(logs, store.VitalsSpO2Log{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		})
	}
	return logs, nil
}

func (b *Bot) parseStressDatabase(dbPath string) ([]store.VitalsStressLog, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type, info FROM stress ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []store.VitalsStressLog
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		var info sql.NullString
		if err := rows.Scan(&dateMs, &tz, &val, &typ, &info); err != nil {
			return nil, err
		}
		l := store.VitalsStressLog{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		}
		if info.Valid {
			l.Info = info.String
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (b *Bot) updateStatusMessage(chatID int64, messageID int, text string) {
	edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
	if _, err := b.api.Send(edit); err != nil {
		log.Printf("[bot] send failed: %v", err)
	}
}
