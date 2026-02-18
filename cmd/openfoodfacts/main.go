package main

import (
	"database/sql"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Printf("Usage: %s <db_path> <csv_path>\n", os.Args[0])
		fmt.Printf("Example: %s data/medtracker.db data/en.openfoodfacts.org.products.csv\n", os.Args[0])
		fmt.Printf("You can pipe gunzip: gunzip -c data/en.openfoodfacts.org.products.csv.gz | %s data/medtracker.db -\n", os.Args[0])
		os.Exit(1)
	}

	dbPath := os.Args[1]
	csvPath := os.Args[2]

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatal("Error opening database:", err)
	}
	defer db.Close()

	// Ensure pragmas for fast inserts
	_, err = db.Exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;")
	if err != nil {
		log.Printf("Warning: failed to set pragmas: %v\n", err)
	}

	var reader io.Reader
	if csvPath == "-" {
		reader = os.Stdin
	} else {
		file, err := os.Open(csvPath)
		if err != nil {
			log.Fatal("Error opening CSV:", err)
		}
		defer file.Close()
		reader = file
	}

	csvReader := csv.NewReader(reader)
	csvReader.Comma = '\t' // OpenFoodFacts uses TSV
	csvReader.LazyQuotes = true
	csvReader.ReuseRecord = true

	// Read header
	header, err := csvReader.Read()
	if err != nil {
		log.Fatal("Error reading header:", err)
	}

	// Map columns
	colIdx := make(map[string]int)
	for i, col := range header {
		colIdx[col] = i
	}

	reqCols := []string{"code", "product_name", "carbohydrates_100g", "proteins_100g", "fat_100g", "energy-kcal_100g"}
	for _, c := range reqCols {
		if _, ok := colIdx[c]; !ok {
			log.Fatalf("Required column %s not found in CSV", c)
		}
	}

	fmt.Println("Starting import...")

	tx, err := db.Begin()
	if err != nil {
		log.Fatal(err)
	}

	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO open_food_facts (barcode, name, carbs_100g, protein_100g, fat_100g, energy_kcal_100g)
		VALUES (?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		log.Fatal(err)
	}
	defer stmt.Close()

	count := 0
	batchSize := 10000

	parseFloat := func(s string) float64 {
		v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return v
	}

	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Skip malformed lines
			continue
		}

		code := strings.TrimSpace(record[colIdx["code"]])
		name := strings.TrimSpace(record[colIdx["product_name"]])

		if code == "" || name == "" {
			continue
		}

		carbs := parseFloat(record[colIdx["carbohydrates_100g"]])
		protein := parseFloat(record[colIdx["proteins_100g"]])
		fat := parseFloat(record[colIdx["fat_100g"]])
		kcal := parseFloat(record[colIdx["energy-kcal_100g"]])

		_, err = stmt.Exec(code, name, carbs, protein, fat, kcal)
		if err != nil {
			log.Printf("Error inserting %s: %v", code, err)
			continue
		}

		count++
		if count%batchSize == 0 {
			if err := tx.Commit(); err != nil {
				log.Fatal(err)
			}
			fmt.Printf("Imported %d records\n", count)
			tx, err = db.Begin()
			if err != nil {
				log.Fatal(err)
			}
			stmt, err = tx.Prepare(`
				INSERT OR REPLACE INTO open_food_facts (barcode, name, carbs_100g, protein_100g, fat_100g, energy_kcal_100g)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			if err != nil {
				log.Fatal(err)
			}
		}
	}

	if err := tx.Commit(); err != nil {
		log.Fatal(err)
	}

	fmt.Printf("Finished! Imported %d records.\n", count)
}
