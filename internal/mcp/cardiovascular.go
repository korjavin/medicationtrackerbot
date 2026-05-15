package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// AnalyzeCardiovascularInput is the input type for the analyze_cardiovascular tool
type AnalyzeCardiovascularInput struct {
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
	Days         int    `json:"days"`
	ExcludeNotes bool   `json:"exclude_notes"`
}

// -- Response sub-structures --

type BPSection struct {
	Readings     []BloodPressureResult `json:"readings"`
	AvgSystolic  int                   `json:"avg_systolic"`
	AvgDiastolic int                   `json:"avg_diastolic"`
	DaysMeasured int                   `json:"days_measured"`
}

type ActiveMedicationResult struct {
	Name     string `json:"name"`
	Dosage   string `json:"dosage"`
	Schedule string `json:"schedule"`
}

type MedicationsSection struct {
	Active        []ActiveMedicationResult `json:"active"`
	IntakeLog     []MedicationIntakeResult `json:"intake_log"`
	AdherenceRate float64                  `json:"adherence_rate"`
}

type SleepSection struct {
	Logs           []SleepLogResult `json:"logs"`
	AvgDurationMin int              `json:"avg_duration_minutes"`
	AvgDeepMin     int              `json:"avg_deep_minutes"`
}

type HeartRateSection struct {
	Avg           int `json:"avg"`
	Min           int `json:"min"`
	Max           int `json:"max"`
	ReadingsCount int `json:"readings_count"`
}

type SpO2Section struct {
	Avg           int `json:"avg"`
	Min           int `json:"min"`
	ReadingsCount int `json:"readings_count"`
}

// AnalyzeCardiovascularResponse is the response for the analyze_cardiovascular tool
type AnalyzeCardiovascularResponse struct {
	Period        string              `json:"period"`
	BloodPressure *BPSection          `json:"blood_pressure,omitempty"`
	Medications   *MedicationsSection `json:"medications,omitempty"`
	Sleep         *SleepSection       `json:"sleep,omitempty"`
	HeartRate     *HeartRateSection   `json:"heart_rate,omitempty"`
	SpO2          *SpO2Section        `json:"spo2,omitempty"`
	DiaryNotes    []ContextNote       `json:"diary_notes,omitempty"`
	Warning       string              `json:"warning,omitempty"`
}

// handleAnalyzeCardiovascular handles the analyze_cardiovascular composite tool
func (s *Server) handleAnalyzeCardiovascular(ctx context.Context, req *sdkmcp.CallToolRequest, input AnalyzeCardiovascularInput) (*sdkmcp.CallToolResult, AnalyzeCardiovascularResponse, error) {
	startDate, endDate, warning, err := s.resolveCompositeRange(req, input.StartDate, input.EndDate, input.Days)
	if err != nil {
		return nil, AnalyzeCardiovascularResponse{}, err
	}

	userID := s.config.UserID
	period := formatPeriod(startDate, endDate)
	var unavailable []string

	response := AnalyzeCardiovascularResponse{
		Period: period,
	}

	// Blood Pressure
	if bpEnabled, err := s.data.GetBloodPressureEnabled(ctx); err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to check BP feature", "error", err)
		unavailable = append(unavailable, "blood_pressure (error checking feature)")
	} else if bpEnabled {
		bp, err := s.fetchBPSection(ctx, userID, startDate, endDate)
		if err != nil {
			unavailable = append(unavailable, "blood_pressure (query failed)")
		} else {
			response.BloodPressure = bp
		}
	} else {
		unavailable = append(unavailable, "blood_pressure (feature disabled)")
	}

	// Medications
	if medEnabled, err := s.data.GetMedicationEnabled(ctx); err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to check medication feature", "error", err)
		unavailable = append(unavailable, "medications (error checking feature)")
	} else if medEnabled {
		meds, err := s.fetchMedicationsSection(startDate, endDate)
		if err != nil {
			unavailable = append(unavailable, "medications (query failed)")
		} else {
			response.Medications = meds
		}
	} else {
		unavailable = append(unavailable, "medications (feature disabled)")
	}

	// Sleep (no feature gate)
	sleep, err := s.fetchSleepSection(ctx, userID, startDate, endDate)
	if err != nil {
		unavailable = append(unavailable, "sleep (query failed)")
	} else {
		response.Sleep = sleep
	}

	// Heart Rate
	hr, err := s.fetchHeartRateSection(ctx, userID, startDate, endDate)
	if err != nil {
		unavailable = append(unavailable, "heart_rate (query failed)")
	} else {
		response.HeartRate = hr
	}

	// SpO2
	spo2, err := s.fetchSpO2Section(ctx, userID, startDate, endDate)
	if err != nil {
		unavailable = append(unavailable, "spo2 (query failed)")
	} else {
		response.SpO2 = spo2
	}

	// Diary Notes
	if shouldIncludeNotes(input.ExcludeNotes) {
		notes, truncated, notesWarn := s.fetchContextNotes(ctx, startDate, endDate)
		response.DiaryNotes = notes
		if truncated {
			warning = appendWarnings(warning, notesTruncatedWarning)
		}
		if notesWarn != "" {
			warning = appendWarnings(warning, notesWarn)
		}
	}

	if len(unavailable) > 0 {
		unavailWarning := "Unavailable sections: " + strings.Join(unavailable, ", ") + "."
		warning = appendWarnings(warning, unavailWarning)
	}
	response.Warning = warning

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "CardiovascularAnalysis",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// resolveCompositeRange resolves start/end date from input, supporting the `days` shorthand.
// Alias normalization runs first so that camelCase aliases (startDate/endDate) are resolved
// before the days shorthand is applied.
func (s *Server) resolveCompositeRange(req *sdkmcp.CallToolRequest, startStr, endStr string, days int) (time.Time, time.Time, string, error) {
	// First, resolve compatibility aliases (startDate → start_date, endDate → end_date)
	resolvedStart, resolvedEnd, argsWarning, err := s.resolveDateRangeArgs(req, startStr, endStr)
	if err != nil {
		return time.Time{}, time.Time{}, "", err
	}

	// If days is provided and start_date is not (even after alias resolution), use days as a shorthand
	if days > 0 && resolvedStart == "" {
		now := time.Now()
		if resolvedEnd == "" {
			resolvedEnd = now.Format("2006-01-02")
		}
		endParsed, err := time.ParseInLocation("2006-01-02", resolvedEnd, now.Location())
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("invalid end_date %q: expected YYYY-MM-DD", resolvedEnd)
		}
		resolvedStart = endParsed.AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	}

	startDate, endDate, warning, err := s.parseDateRange(resolvedStart, resolvedEnd)
	if err != nil {
		return time.Time{}, time.Time{}, "", err
	}
	warning = appendWarnings(argsWarning, warning)
	return startDate, endDate, warning, nil
}

func (s *Server) fetchBPSection(ctx context.Context, userID int64, startDate, endDate time.Time) (*BPSection, error) {
	readings, err := s.data.GetBloodPressureReadings(ctx, userID, startDate)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch BP", "error", err)
		return nil, err
	}

	var results []BloodPressureResult
	var sumSys, sumDia int
	daysSet := make(map[string]bool)
	for _, r := range readings {
		if r.MeasuredAt.After(endDate) {
			continue
		}
		pulse := 0
		if r.Pulse != nil {
			pulse = *r.Pulse
		}
		results = append(results, BloodPressureResult{
			MeasuredAt: r.MeasuredAt.Format("2006-01-02 15:04"),
			Systolic:   r.Systolic,
			Diastolic:  r.Diastolic,
			Pulse:      pulse,
			Category:   r.Category,
			Notes:      r.Notes,
		})
		sumSys += r.Systolic
		sumDia += r.Diastolic
		daysSet[r.MeasuredAt.Format("2006-01-02")] = true
	}

	avgSys, avgDia := 0, 0
	if len(results) > 0 {
		avgSys = sumSys / len(results)
		avgDia = sumDia / len(results)
	}

	return &BPSection{
		Readings:     results,
		AvgSystolic:  avgSys,
		AvgDiastolic: avgDia,
		DaysMeasured: len(daysSet),
	}, nil
}

func (s *Server) fetchMedicationsSection(startDate, endDate time.Time) (*MedicationsSection, error) {
	// Active medications
	meds, err := s.data.List(false)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch medications", "error", err)
		return nil, err
	}

	var activeMeds []ActiveMedicationResult
	for _, m := range meds {
		activeMeds = append(activeMeds, ActiveMedicationResult{
			Name:     m.Name,
			Dosage:   m.Dosage,
			Schedule: m.Schedule,
		})
	}

	// Intake log
	intakes, err := s.data.ListIntakesSince(startDate)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch intakes", "error", err)
		return nil, fmt.Errorf("fetch medication intakes: %w", err)
	}

	var intakeResults []MedicationIntakeResult
	var totalIntakes, takenIntakes int
	for _, intake := range intakes {
		if intake.ScheduledAt.After(endDate) {
			continue
		}

		var takenAt *string
		if intake.TakenAt != nil {
			t := intake.TakenAt.Format("2006-01-02 15:04")
			takenAt = &t
		}
		intakeResults = append(intakeResults, MedicationIntakeResult{
			MedicationName: intake.MedicationName,
			Dosage:         intake.MedicationDosage,
			ScheduledAt:    intake.ScheduledAt.Format("2006-01-02 15:04"),
			TakenAt:        takenAt,
			Status:         intake.Status,
		})

		// Count resolved intakes (TAKEN, SKIPPED, MISSED) in adherence.
		// For PENDING intakes: only exclude those scheduled in the future (not yet due).
		// Overdue PENDING intakes (scheduled in the past, never confirmed/skipped) should
		// count against adherence since the user missed acting on them.
		if intake.Status == "PENDING" && intake.ScheduledAt.After(time.Now()) {
			continue
		}
		totalIntakes++
		if intake.Status == "TAKEN" {
			takenIntakes++
		}
	}

	adherence := 0.0
	if totalIntakes > 0 {
		adherence = float64(takenIntakes) / float64(totalIntakes) * 100
	}

	return &MedicationsSection{
		Active:        activeMeds,
		IntakeLog:     intakeResults,
		AdherenceRate: adherence,
	}, nil
}

func (s *Server) fetchSleepSection(ctx context.Context, userID int64, startDate, endDate time.Time) (*SleepSection, error) {
	logs, err := s.data.GetSleepLogs(ctx, userID, startDate)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch sleep", "error", err)
		return nil, err
	}

	var results []SleepLogResult
	var totalDuration, totalDeep int
	var countDuration, countDeep int
	for _, l := range logs {
		if l.StartTime.After(endDate) {
			continue
		}
		res := SleepLogResult{
			StartTime:    l.StartTime.Format("2006-01-02 15:04"),
			EndTime:      l.EndTime.Format("2006-01-02 15:04"),
			TotalMinutes: l.TotalMinutes,
			DeepMinutes:  l.DeepMinutes,
			LightMinutes: l.LightMinutes,
			REMMinutes:   l.REMMinutes,
			AwakeMinutes: l.AwakeMinutes,
			HeartRateAvg: l.HeartRateAvg,
			SpO2Avg:      l.SpO2Avg,
			Notes:        l.Notes,
		}
		results = append(results, res)
		if l.TotalMinutes != nil {
			totalDuration += *l.TotalMinutes
			countDuration++
		}
		if l.DeepMinutes != nil {
			totalDeep += *l.DeepMinutes
			countDeep++
		}
	}

	avgDuration, avgDeep := 0, 0
	if countDuration > 0 {
		avgDuration = totalDuration / countDuration
	}
	if countDeep > 0 {
		avgDeep = totalDeep / countDeep
	}

	return &SleepSection{
		Logs:           results,
		AvgDurationMin: avgDuration,
		AvgDeepMin:     avgDeep,
	}, nil
}

func (s *Server) fetchHeartRateSection(ctx context.Context, userID int64, startDate, endDate time.Time) (*HeartRateSection, error) {
	logs, err := s.data.GetVitalsHeart(ctx, userID, startDate, endDate)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch heart rate", "error", err)
		return nil, err
	}
	if len(logs) == 0 {
		return nil, nil
	}

	sum, minV, maxV := 0, logs[0].Value, logs[0].Value
	for _, l := range logs {
		sum += l.Value
		if l.Value < minV {
			minV = l.Value
		}
		if l.Value > maxV {
			maxV = l.Value
		}
	}

	return &HeartRateSection{
		Avg:           sum / len(logs),
		Min:           minV,
		Max:           maxV,
		ReadingsCount: len(logs),
	}, nil
}

func (s *Server) fetchSpO2Section(ctx context.Context, userID int64, startDate, endDate time.Time) (*SpO2Section, error) {
	logs, err := s.data.GetVitalsSpO2(ctx, userID, startDate, endDate)
	if err != nil {
		slog.Warn("[MCP] CardiovascularAnalysis: failed to fetch SpO2", "error", err)
		return nil, err
	}
	if len(logs) == 0 {
		return nil, nil
	}

	sum, minV := 0, logs[0].Value
	for _, l := range logs {
		sum += l.Value
		if l.Value < minV {
			minV = l.Value
		}
	}

	return &SpO2Section{
		Avg:           sum / len(logs),
		Min:           minV,
		ReadingsCount: len(logs),
	}, nil
}

// registerCardiovascularTool registers the analyze_cardiovascular composite tool
func registerCardiovascularTool(mcpServer *sdkmcp.Server, s *Server) {
	sdkmcp.AddTool(mcpServer,
		&sdkmcp.Tool{
			Name:        "analyze_cardiovascular",
			Description: "Comprehensive cardiovascular health analysis. Returns blood pressure readings with daily averages, active medications and adherence, sleep duration and quality, heart rate and SpO2 trends, and personal diary notes — all in one call. Maximum 90 days per query. Use this for any question about blood pressure, heart health, medication effects, or sleep quality.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if both start_date and days are omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					},
					"days": {
						"type": "integer",
						"description": "Number of days to look back from end_date. Alternative to start_date — e.g. days=30 means last 30 days. Ignored if start_date is provided."
					},
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Default false."
					}
				}
			}`),
		},
		s.handleAnalyzeCardiovascular,
	)
}
