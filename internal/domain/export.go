package domain

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strconv"
	"time"
)

// MedicationIntake holds the data needed for medication CSV export.
type MedicationIntake struct {
	ScheduledAt      time.Time
	TakenAt          *time.Time
	MedicationName   string
	MedicationDosage string
}

// GenerateMedicationCSV produces a CSV export of medication intake data.
func GenerateMedicationCSV(intakes []MedicationIntake) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	if err := writer.Write([]string{"date time", "medicine name", "dosage"}); err != nil {
		return nil, err
	}

	for _, intake := range intakes {
		dateTime := intake.ScheduledAt.Format("2006-01-02 15:04")
		if intake.TakenAt != nil {
			dateTime = intake.TakenAt.Format("2006-01-02 15:04")
		}
		row := []string{dateTime, intake.MedicationName, intake.MedicationDosage}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}

// BPExportReading holds the data needed for BP CSV export.
type BPExportReading struct {
	MeasuredAt time.Time
	Systolic   int
	Diastolic  int
	Pulse      *int
	Category   string
}

// GenerateBPCSV produces a CSV export of blood pressure readings.
func GenerateBPCSV(readings []BPExportReading) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	if err := writer.Write([]string{"date time", "systolic", "diastolic", "pulse", "category"}); err != nil {
		return nil, err
	}

	for _, bp := range readings {
		dateTime := bp.MeasuredAt.Format("2006-01-02 15:04")
		pulse := ""
		if bp.Pulse != nil {
			pulse = strconv.Itoa(*bp.Pulse)
		}
		category := bp.Category
		if category == "" {
			category = CalculateBPCategory(bp.Systolic, bp.Diastolic)
		}
		row := []string{dateTime, strconv.Itoa(bp.Systolic), strconv.Itoa(bp.Diastolic), pulse, category}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}

// WeightExportLog holds the data needed for weight CSV export.
type WeightExportLog struct {
	MeasuredAt      time.Time
	Weight          float64
	WeightTrend     *float64
	BodyFat         *float64
	BodyFatTrend    *float64
	MuscleMass      *float64
	MuscleMassTrend *float64
	Notes           string
}

// GenerateWeightCSV produces a CSV export in Libra format.
func GenerateWeightCSV(logs []WeightExportLog) ([]byte, error) {
	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	_ = writer.Write([]string{"#Version: 6"})
	_ = writer.Write([]string{"#Units: kg"})
	_ = writer.Write([]string{""})
	_ = writer.Write([]string{"#date;weight;weight trend;body fat;body fat trend;muscle mass;muscle mass trend;log"})

	for _, w := range logs {
		dateTime := w.MeasuredAt.Format("2006-01-02T15:04:05.000Z")

		weight := fmt.Sprintf("%.1f", w.Weight)
		weightTrend := ""
		if w.WeightTrend != nil {
			weightTrend = fmt.Sprintf("%.1f", *w.WeightTrend)
		}

		bodyFat := ""
		if w.BodyFat != nil {
			bodyFat = fmt.Sprintf("%.1f", *w.BodyFat)
		}

		bodyFatTrend := ""
		if w.BodyFatTrend != nil {
			bodyFatTrend = fmt.Sprintf("%.1f", *w.BodyFatTrend)
		}

		muscleMass := ""
		if w.MuscleMass != nil {
			muscleMass = fmt.Sprintf("%.1f", *w.MuscleMass)
		}

		muscleMassTrend := ""
		if w.MuscleMassTrend != nil {
			muscleMassTrend = fmt.Sprintf("%.1f", *w.MuscleMassTrend)
		}

		row := []string{
			dateTime + ";" + weight + ";" + weightTrend + ";" + bodyFat + ";" + bodyFatTrend + ";" + muscleMass + ";" + muscleMassTrend + ";" + w.Notes,
		}
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}
