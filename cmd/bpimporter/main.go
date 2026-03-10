package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func main() {
	csvPath := flag.String("csv", "", "Path to CSV file")
	userID := flag.Int64("user", 0, "User ID (optional, will use first user if not provided)")
	dbPath := flag.String("db", "data.db", "Path to SQLite database")
	flag.Parse()

	if *csvPath == "" {
		slog.Error("Please provide -csv <path>")
		os.Exit(1)
	}

	// Open database
	s, err := store.New(*dbPath)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	defer s.Close()

	// If user ID not provided, get the first user
	if *userID == 0 {
		meds, err := s.ListMedications(false)
		if err != nil {
			slog.Error("Failed to list medications", "error", err)
			os.Exit(1)
		}
		if len(meds) == 0 {
			slog.Error("No users found in database. Please provide -user <id>")
			os.Exit(1)
		}
		// Use user ID 1 as default (the system is designed for single-user)
		*userID = 1
		slog.Info("Using default user ID", "userID", *userID)
	}

	// Read CSV file
	file, err := os.Open(*csvPath)
	if err != nil {
		slog.Error("Failed to open CSV file", "error", err)
		os.Exit(1)
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	// Read header
	header, err := reader.Read()
	if err != nil {
		slog.Error("Failed to read CSV header", "error", err)
		os.Exit(1)
	}

	// Parse header to column indices
	colMap := make(map[string]int)
	for i, col := range header {
		colMap[strings.ToLower(strings.TrimSpace(col))] = i
	}

	// Validate required columns
	requiredCols := []string{"date", "systolic", "diastolic"}
	for _, col := range requiredCols {
		if _, ok := colMap[col]; !ok {
			slog.Error("Missing required column", "column", col)
			os.Exit(1)
		}
	}

	// Parse date layout as per CSV format
	dateLayout := "2006-01-02 15:04"

	var readings []store.BloodPressure
	var skippedRows int
	rowNum := 1

	for {
		row, err := reader.Read()
		if err != nil {
			break
		}
		rowNum++

		// Skip empty rows
		if len(row) == 0 || (len(row) == 1 && strings.TrimSpace(row[0]) == "") {
			continue
		}

		var bp store.BloodPressure

		// Parse Date (required)
		dateStr := getCol(row, colMap, "date")
		if dateStr != "" {
			parsedTime, err := time.Parse(dateLayout, strings.TrimSpace(dateStr))
			if err != nil {
				slog.Warn("Invalid date format", "row", rowNum, "date", dateStr, "error", err) // #nosec G706
				skippedRows++
				continue
			}
			bp.MeasuredAt = parsedTime
		}

		// Parse Systolic (required)
		systolicStr := getCol(row, colMap, "systolic")
		if systolicStr != "" {
			systolic, err := strconv.Atoi(strings.TrimSpace(systolicStr))
			if err != nil {
				slog.Warn("Invalid systolic value", "row", rowNum, "value", systolicStr, "error", err) // #nosec G706
				skippedRows++
				continue
			}
			bp.Systolic = systolic
		}

		// Parse Diastolic (required)
		diastolicStr := getCol(row, colMap, "diastolic")
		if diastolicStr != "" {
			diastolic, err := strconv.Atoi(strings.TrimSpace(diastolicStr))
			if err != nil {
				slog.Warn("Invalid diastolic value", "row", rowNum, "value", diastolicStr, "error", err) // #nosec G706
				skippedRows++
				continue
			}
			bp.Diastolic = diastolic
		}

		// Parse Pulse (optional)
		pulseStr := getCol(row, colMap, "pulse")
		if pulseStr != "" {
			if pulse, err := strconv.Atoi(strings.TrimSpace(pulseStr)); err == nil {
				bp.Pulse = &pulse
			}
		}

		// Parse Site (optional)
		site := getCol(row, colMap, "site")
		if site != "" {
			bp.Site = strings.TrimSpace(site)
		}

		// Parse Position (optional)
		position := getCol(row, colMap, "position")
		if position != "" {
			bp.Position = strings.TrimSpace(position)
		}

		// Category will be recalculated by ImportBloodPressureReadings if empty

		// Parse Ignore Calculation (optional)
		ignoreCalcStr := getCol(row, colMap, "ignore calculation")
		if ignoreCalcStr != "" {
			ignoreCalcStr = strings.ToLower(strings.TrimSpace(ignoreCalcStr))
			bp.IgnoreCalc = ignoreCalcStr == "y" || ignoreCalcStr == "yes" || ignoreCalcStr == "true" || ignoreCalcStr == "1"
		}

		// Parse Notes (optional)
		notes := getCol(row, colMap, "notes")
		if notes != "" {
			bp.Notes = strings.TrimSpace(notes)
		}

		// Parse Tag (optional)
		tag := getCol(row, colMap, "tag")
		if tag != "" {
			bp.Tag = strings.TrimSpace(tag)
		}

		readings = append(readings, bp)

		// Print progress every 10 records
		if len(readings)%10 == 0 {
			slog.Info("Parsing records", "count", len(readings))
		}
	}

	slog.Info("CSV parsing complete", "parsed", len(readings), "skipped", skippedRows)

	if len(readings) == 0 {
		slog.Error("No valid records to import")
		os.Exit(1)
	}

	// Import readings
	ctx := context.Background()
	err = s.ImportBloodPressureReadings(ctx, *userID, readings)
	if err != nil {
		slog.Error("Failed to import blood pressure readings", "error", err)
		os.Exit(1)
	}

	fmt.Printf("Imported %d blood pressure records for user %d\n", len(readings), *userID)
}

func getCol(row []string, colMap map[string]int, colName string) string {
	if idx, ok := colMap[colName]; ok && idx < len(row) {
		return row[idx]
	}
	return ""
}
