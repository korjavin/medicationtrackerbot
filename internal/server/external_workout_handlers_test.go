package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockMiBandStore struct {
	MiBandStore // embed interface to satisfy unspecified methods

	insertFunc func(ctx context.Context, w *store.MiBandWorkout) (bool, error)
	checkFunc  func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error)
}

func (m *mockMiBandStore) InsertMiBandWorkout(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
	if m.insertFunc != nil {
		return m.insertFunc(ctx, w)
	}
	return true, nil
}

func (m *mockMiBandStore) CheckDuplicateMiBandWorkout(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
	if m.checkFunc != nil {
		return m.checkFunc(ctx, userID, startMsMin, startMsMax)
	}
	return false, nil
}

func TestHandleExternalWorkout(t *testing.T) {
	mockStore := &mockMiBandStore{}

	s := &Server{
		externalAPIKey: "testkey",
		miband:         mockStore,
		allowedUserID:  42,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/workout/external", s.externalAPIKeyMiddleware(s.handleExternalWorkout))

	cases := []struct {
		name           string
		authHeader     string
		body           map[string]interface{}
		mockInsertFunc func(ctx context.Context, w *store.MiBandWorkout) (bool, error)
		mockCheckFunc  func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error)
		wantStatus     int
		wantRespKey    string
		wantRespValue  string
	}{
		{
			name:       "missing auth header",
			authHeader: "",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000,
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "wrong auth header",
			authHeader: "Bearer wrongkey",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000,
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing required field workout_type",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"start_time": 1700000000,
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing required field start_time",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"workout_type": "running",
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "malformed json",
			authHeader: "Bearer testkey",
			body:       nil, // Handled specially below
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "valid request - new workout",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000,
				"spo2":         97,
			},
			mockInsertFunc: func(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
				w.ID = 123
				if w.SourceStartMs != 1700000000000 {
					t.Errorf("expected start_time to be converted to ms, got %v", w.SourceStartMs)
				}
				if w.ActivityName != "running" {
					t.Errorf("expected activity_name running, got %v", w.ActivityName)
				}
				if w.UserID != 42 {
					t.Errorf("expected user id 42, got %v", w.UserID)
				}
				if w.SpO2Avg != 97 {
					t.Errorf("expected spo2_avg 97, got %v", w.SpO2Avg)
				}
				return true, nil
			},
			wantStatus:    http.StatusOK,
			wantRespKey:   "status",
			wantRespValue: "ok",
		},
		{
			name:       "valid request - deduplicated workout (exact)",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000,
			},
			mockInsertFunc: func(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
				return false, nil // deduplicated
			},
			mockCheckFunc: func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
				return false, nil
			},
			wantStatus:    http.StatusOK,
			wantRespKey:   "status",
			wantRespValue: "duplicate",
		},
		{
			name:       "valid request - deduplicated workout (fuzzy seconds)",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000, // seconds
			},
			mockCheckFunc: func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
				if startMsMin != 1700000000000 || startMsMax != 1700000000999 {
					t.Errorf("expected fuzzy range 1700000000000-1700000000999, got %v-%v", startMsMin, startMsMax)
				}
				return true, nil // duplicate found
			},
			wantStatus:    http.StatusOK,
			wantRespKey:   "status",
			wantRespValue: "duplicate",
		},
		{
			name:       "timestamp in ms",
			authHeader: "Bearer testkey",
			body: map[string]interface{}{
				"workout_type": "running",
				"start_time":   1700000000123,
			},
			mockInsertFunc: func(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
				if w.SourceStartMs != 1700000000123 {
					t.Errorf("expected start_time to remain in ms, got %v", w.SourceStartMs)
				}
				return true, nil
			},
			wantStatus:    http.StatusOK,
			wantRespKey:   "status",
			wantRespValue: "ok",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mockStore.insertFunc = tc.mockInsertFunc
			mockStore.checkFunc = tc.mockCheckFunc

			var reqBody []byte
			if tc.name == "malformed json" {
				reqBody = []byte(`{invalid json`)
			} else {
				reqBody, _ = json.Marshal(tc.body)
			}

			req := httptest.NewRequest(http.MethodPost, "/api/workout/external", bytes.NewReader(reqBody))
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}

			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Errorf("expected status %v, got %v", tc.wantStatus, rr.Code)
			}

			if tc.wantRespKey != "" && rr.Code == http.StatusOK {
				var resp map[string]interface{}
				if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
					t.Fatalf("failed to parse response: %v", err)
				}
				if resp[tc.wantRespKey] != tc.wantRespValue {
					t.Errorf("expected %s=%v, got %v", tc.wantRespKey, tc.wantRespValue, resp[tc.wantRespKey])
				}
			}
		})
	}
}

func TestHandleBulkImportWorkouts(t *testing.T) {
	mockStore := &mockMiBandStore{}

	s := &Server{
		externalAPIKey: "testkey",
		miband:         mockStore,
		allowedUserID:  42,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/workout/miband/import", s.handleBulkImportWorkouts)

	cases := []struct {
		name           string
		body           string
		mockInsertFunc func(ctx context.Context, w *store.MiBandWorkout) (bool, error)
		mockCheckFunc  func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error)
		wantStatus     int
		wantImported   int
		wantDuplicates int
		wantErrors     int
	}{
		{
			name:       "invalid json format",
			body:       `{"not": "an array"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "valid import with new and duplicate",
			body: `[
				{"workout_type": "running", "start_time": 1700000000, "spo2": 95},
				{"workout_type": "cycling", "start_time": 1700000000, "spo2": 97}
			]`,
			mockInsertFunc: func(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
				if w.ActivityName == "running" {
					if w.SpO2Avg != 95 {
						t.Errorf("expected spo2 95, got %v", w.SpO2Avg)
					}
					return true, nil // inserted
				}
				if w.ActivityName == "cycling" {
					return false, nil // duplicate on insert
				}
				return true, nil
			},
			mockCheckFunc: func(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
				return false, nil
			},
			wantStatus:     http.StatusOK,
			wantImported:   1,
			wantDuplicates: 1,
			wantErrors:     0,
		},
		{
			name: "error case with missing required fields",
			body: `[
				{"start_time": 1700000000},
				{"workout_type": "running"}
			]`,
			mockInsertFunc: func(ctx context.Context, w *store.MiBandWorkout) (bool, error) {
				return true, nil
			},
			wantStatus:     http.StatusOK,
			wantImported:   0,
			wantDuplicates: 0,
			wantErrors:     2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mockStore.insertFunc = tc.mockInsertFunc
			mockStore.checkFunc = tc.mockCheckFunc

			req := httptest.NewRequest(http.MethodPost, "/api/workout/miband/import", strings.NewReader(tc.body))

			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Errorf("expected status %v, got %v", tc.wantStatus, rr.Code)
			}

			if rr.Code == http.StatusOK {
				var resp map[string]interface{}
				if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
					t.Fatalf("failed to parse response: %v", err)
				}

				if int(resp["imported"].(float64)) != tc.wantImported {
					t.Errorf("expected imported %v, got %v", tc.wantImported, resp["imported"])
				}
				if int(resp["duplicates"].(float64)) != tc.wantDuplicates {
					t.Errorf("expected duplicates %v, got %v", tc.wantDuplicates, resp["duplicates"])
				}
				if int(resp["errors"].(float64)) != tc.wantErrors {
					t.Errorf("expected errors %v, got %v", tc.wantErrors, resp["errors"])
				}
			}
		})
	}
}
