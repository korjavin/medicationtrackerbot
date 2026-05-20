package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleGetUpcomingReminders_EmptyWhenNoMeds(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/reminders/upcoming", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))

	w := httptest.NewRecorder()
	srv.handleGetUpcomingReminders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var out []upcomingReminder
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("expected empty list, got %d entries", len(out))
	}
}

func TestHandleGetUpcomingReminders_ReturnsPendingWithinWindow(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)

	// Three medications, three intakes: one in 1 hour, one in 30 hours, one
	// already past. Default window is 24h, so only the first should appear.
	medSoon, _ := db.Medication.Create("Soon", "10mg", "Wait", nil, nil, "", "", "")
	medLater, _ := db.Medication.Create("Later", "20mg", "Wait", nil, nil, "", "", "")
	medPast, _ := db.Medication.Create("Past", "5mg", "Wait", nil, nil, "", "", "")

	now := time.Now()
	soonID, _ := db.Medication.CreateIntake(medSoon, userID, now.Add(1*time.Hour))
	_, _ = db.Medication.CreateIntake(medLater, userID, now.Add(30*time.Hour))
	_, _ = db.Medication.CreateIntake(medPast, userID, now.Add(-1*time.Hour))

	req := httptest.NewRequest(http.MethodGet, "/api/reminders/upcoming", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))

	w := httptest.NewRecorder()
	srv.handleGetUpcomingReminders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	var out []upcomingReminder
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 reminder in 24h window, got %d: %+v", len(out), out)
	}
	if out[0].IntakeID != soonID {
		t.Errorf("expected intake_id=%d, got %d", soonID, out[0].IntakeID)
	}
	if out[0].MedicationName != "Soon" {
		t.Errorf("expected MedicationName=Soon, got %q", out[0].MedicationName)
	}
}

func TestHandleGetUpcomingReminders_HoursQueryParamExpandsWindow(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medA, _ := db.Medication.Create("A", "10mg", "Wait", nil, nil, "", "", "")
	medB, _ := db.Medication.Create("B", "20mg", "Wait", nil, nil, "", "", "")

	now := time.Now()
	_, _ = db.Medication.CreateIntake(medA, userID, now.Add(1*time.Hour))
	_, _ = db.Medication.CreateIntake(medB, userID, now.Add(30*time.Hour))

	// hours=48 should include both.
	req := httptest.NewRequest(http.MethodGet, "/api/reminders/upcoming?hours=48", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))

	w := httptest.NewRecorder()
	srv.handleGetUpcomingReminders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var out []upcomingReminder
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(out) != 2 {
		t.Errorf("expected 2 reminders with hours=48, got %d", len(out))
	}
}

func TestHandleGetUpcomingReminders_SortedByScheduledAtAscending(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medA, _ := db.Medication.Create("A", "10mg", "Wait", nil, nil, "", "", "")
	medB, _ := db.Medication.Create("B", "20mg", "Wait", nil, nil, "", "", "")
	medC, _ := db.Medication.Create("C", "30mg", "Wait", nil, nil, "", "", "")

	now := time.Now()
	// Insert out of chronological order.
	_, _ = db.Medication.CreateIntake(medB, userID, now.Add(5*time.Hour))
	_, _ = db.Medication.CreateIntake(medA, userID, now.Add(1*time.Hour))
	_, _ = db.Medication.CreateIntake(medC, userID, now.Add(10*time.Hour))

	req := httptest.NewRequest(http.MethodGet, "/api/reminders/upcoming", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))

	w := httptest.NewRecorder()
	srv.handleGetUpcomingReminders(w, req)

	var out []upcomingReminder
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(out) != 3 {
		t.Fatalf("expected 3 reminders, got %d", len(out))
	}
	names := []string{out[0].MedicationName, out[1].MedicationName, out[2].MedicationName}
	if names[0] != "A" || names[1] != "B" || names[2] != "C" {
		t.Errorf("expected sorted A,B,C, got %v", names)
	}
}

func TestHandleGetUpcomingReminders_InvalidHoursParamFallsBackToDefault(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medA, _ := db.Medication.Create("A", "10mg", "Wait", nil, nil, "", "", "")
	_, _ = db.Medication.CreateIntake(medA, userID, time.Now().Add(2*time.Hour))

	// hours=999 (above max 168) should fall back to default 24h, NOT reject the request.
	req := httptest.NewRequest(http.MethodGet, "/api/reminders/upcoming?hours=999", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))

	w := httptest.NewRecorder()
	srv.handleGetUpcomingReminders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 with fallback, got %d", w.Code)
	}
	var out []upcomingReminder
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 1 {
		t.Errorf("expected 1 reminder with default 24h window, got %d", len(out))
	}
}
