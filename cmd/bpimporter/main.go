package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"log"
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
		log.Fatal("Please provide -csv <path>")
	}

	// Open database
	s, err := store.New(*dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer s.Close()

	// If user ID not provided, get the first user
	if *userID == 0 {
		meds, err := s.ListMedications(false)
		if err != nil {
			log.Fatalf("Failed to list medications: %v", err)
		}
		if len(meds) == 0 {
			log.Fatal("No users found in database. Please provide -user <id>")
		}
		// Use user ID 1 as default (the system is designed for single-user)
		*userID = 1
		log.Printf("Using default user ID: %d", *userID)
	}

	// Read CSV file
	file, err := os.Open(*csvPath)
	if err != nil {
		log.Fatalf("Failed to open CSV file: %v", err)
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	// Read header
	header, err := reader.Read()
	if err != nil {
		log.Fatalf("Failed to read CSV header: %v", err)
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
			log.Fatalf("Missing required column: %s", col)
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
				log.Printf("Warning: Row %d - Invalid date format '%s': %v", rowNum, dateStr, err)
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
				log.Printf("Warning: Row %d - Invalid systolic value '%s': %v", rowNum, systolicStr, err)
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
				log.Printf("Warning: Row %d - Invalid diastolic value '%s': %v", rowNum, diastolicStr, err)
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
			log.Printf("Parsed %d records...", len(readings))
		}
	}

	log.Printf("Parsed %d records from CSV, %d rows skipped due to errors", len(readings), skippedRows)

	if len(readings) == 0 {
		log.Fatal("No valid records to import")
	}

	// Import readings
	ctx := context.Background()
	err = s.ImportBloodPressureReadings(ctx, *userID, readings)
	if err != nil {
		log.Fatalf("Failed to import blood pressure readings: %v", err)
	}

	fmt.Printf("Imported %d blood pressure records for user %d\n", len(readings), *userID)
}

func getCol(row []string, colMap map[string]int, colName string) string {
	if idx, ok := colMap[colName]; ok && idx < len(row) {
		return row[idx]
	}
	return ""
}
