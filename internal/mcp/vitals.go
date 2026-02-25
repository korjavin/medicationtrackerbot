package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// -- Vitals results --

type HeartRateResult struct {
	DateTime string `json:"date_time"`
	Value    int    `json:"value"`
}

type SpO2Result struct {
	DateTime string `json:"date_time"`
	Value    int    `json:"value"`
}

type StressResult struct {
	DateTime string `json:"date_time"`
	Value    int    `json:"value"`
	Info     string `json:"info,omitempty"`
}

type VitalsResponse struct {
	Logs    interface{} `json:"logs"`
	Count   int         `json:"count"`
	Period  string      `json:"period"`
	Warning string      `json:"warning,omitempty"`
}

// handleGetVitalsHeart handles the get_vitals_heart tool
func (s *Server) handleGetVitalsHeart(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, VitalsResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	userID := s.config.UserID
	logs, err := s.store.GetVitalsHeart(ctx, userID, startDate, endDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}

	// Filter down logs if too many (context limit protection)
	// Example: just grab daily average if span is big.
	// For simplicity, we just return all for now.
	maxItems := 1440 // 1 day of minute data
	if len(logs) > maxItems {
		warning = appendWarnings(warning, fmt.Sprintf("Data truncated: %d results down to %d limits.", len(logs), maxItems))
		logs = logs[:maxItems]
	}

	var results []HeartRateResult
	for _, l := range logs {
		results = append(results, HeartRateResult{
			DateTime: l.DateTime.Format("2006-01-02 15:04"),
			Value:    l.Value,
		})
	}

	return nil, VitalsResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}, nil
}

// handleGetVitalsSpO2 handles the get_vitals_spo2 tool
func (s *Server) handleGetVitalsSpO2(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, VitalsResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	userID := s.config.UserID
	logs, err := s.store.GetVitalsSpO2(ctx, userID, startDate, endDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}

	maxItems := 1440
	if len(logs) > maxItems {
		warning = appendWarnings(warning, fmt.Sprintf("Data truncated: %d results down to %d limits.", len(logs), maxItems))
		logs = logs[:maxItems]
	}

	var results []SpO2Result
	for _, l := range logs {
		results = append(results, SpO2Result{
			DateTime: l.DateTime.Format("2006-01-02 15:04"),
			Value:    l.Value,
		})
	}

	return nil, VitalsResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}, nil
}

// handleGetVitalsStress handles the get_vitals_stress tool
func (s *Server) handleGetVitalsStress(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, VitalsResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, VitalsResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	userID := s.config.UserID
	logs, err := s.store.GetVitalsStress(ctx, userID, startDate, endDate)
	if err != nil {
		return nil, VitalsResponse{}, err
	}

	maxItems := 1440
	if len(logs) > maxItems {
		warning = appendWarnings(warning, fmt.Sprintf("Data truncated: %d results down to %d limits.", len(logs), maxItems))
		logs = logs[:maxItems]
	}

	var results []StressResult
	for _, l := range logs {
		results = append(results, StressResult{
			DateTime: l.DateTime.Format("2006-01-02 15:04"),
			Value:    l.Value,
			Info:     l.Info,
		})
	}

	return nil, VitalsResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}, nil
}

// handleGetHealthOverview handles the get_health_overview tool
type HealthOverviewResponse struct {
	AverageHeartRate int    `json:"average_heart_rate"`
	AverageSpO2      int    `json:"average_spo2"`
	AverageStress    int    `json:"average_stress"`
	CountHeart       int    `json:"count_heart"`
	CountSpO2        int    `json:"count_spo2"`
	CountStress      int    `json:"count_stress"`
	Period           string `json:"period"`
	Warning          string `json:"warning,omitempty"`
}

func (s *Server) handleGetHealthOverview(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, HealthOverviewResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, HealthOverviewResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, HealthOverviewResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	userID := s.config.UserID

	heartLogs, _ := s.store.GetVitalsHeart(ctx, userID, startDate, endDate)
	spo2Logs, _ := s.store.GetVitalsSpO2(ctx, userID, startDate, endDate)
	stressLogs, _ := s.store.GetVitalsStress(ctx, userID, startDate, endDate)

	var hSum, oSum, sSum int
	for _, l := range heartLogs {
		hSum += l.Value
	}
	for _, l := range spo2Logs {
		oSum += l.Value
	}
	for _, l := range stressLogs {
		sSum += l.Value
	}

	hAvg, oAvg, sAvg := 0, 0, 0
	if len(heartLogs) > 0 {
		hAvg = hSum / len(heartLogs)
	}
	if len(spo2Logs) > 0 {
		oAvg = oSum / len(spo2Logs)
	}
	if len(stressLogs) > 0 {
		sAvg = sSum / len(stressLogs)
	}

	return nil, HealthOverviewResponse{
		AverageHeartRate: hAvg,
		AverageSpO2:      oAvg,
		AverageStress:    sAvg,
		CountHeart:       len(heartLogs),
		CountSpO2:        len(spo2Logs),
		CountStress:      len(stressLogs),
		Period:           formatPeriod(startDate, endDate),
		Warning:          warning,
	}, nil
}

func registerVitalsTools(mcpServer *mcp.Server, s *Server) {
	mcp.AddTool(mcpServer,
		&mcp.Tool{
			Name:        "get_health_overview",
			Description: "Retrieve an aggregated overview of vitals (Heart Rate, SpO2, Stress) across a date range. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format."
					}
				}
			}`),
		},
		s.handleGetHealthOverview,
	)

	mcp.AddTool(mcpServer,
		&mcp.Tool{
			Name:        "get_vitals_heart",
			Description: "Retrieve detailed heart rate vitals for a date range. Returns specific data points.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format."
					}
				}
			}`),
		},
		s.handleGetVitalsHeart,
	)

	mcp.AddTool(mcpServer,
		&mcp.Tool{
			Name:        "get_vitals_spo2",
			Description: "Retrieve detailed SpO2 (blood oxygen) vitals for a date range. Returns specific data points.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format."
					}
				}
			}`),
		},
		s.handleGetVitalsSpO2,
	)

	mcp.AddTool(mcpServer,
		&mcp.Tool{
			Name:        "get_vitals_stress",
			Description: "Retrieve detailed stress vitals for a date range. Returns specific data points.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format."
					}
				}
			}`),
		},
		s.handleGetVitalsStress,
	)
}
