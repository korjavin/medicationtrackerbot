package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleFeatureSettings(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Toggle BP off
	reqBody := map[string]interface{}{"enabled": false}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/settings/features/bp", bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("feature", "bp")
	w := httptest.NewRecorder()
	srv.handleSetFeatureEnabled(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	enabled, err := db.GetBloodPressureEnabled(context.Background())
	if err != nil {
		t.Fatalf("GetBloodPressureEnabled failed: %v", err)
	}
	if enabled {
		t.Fatalf("Expected BP feature disabled")
	}

	// Read all feature settings
	getReq := httptest.NewRequest("GET", "/api/settings/features", nil)
	getReq = withUser(getReq, 123456)
	getW := httptest.NewRecorder()
	srv.handleGetFeatureSettings(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", getW.Code)
	}

	var resp map[string]bool
	if err := json.NewDecoder(getW.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if resp["bp"] {
		t.Fatalf("Expected bp=false in feature response")
	}
}

func TestHandleBootstrap(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if _, err := db.CreateMedication("Bootstrap Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	if _, ok := payload["features"].(map[string]any); !ok {
		t.Fatalf("Expected features object in bootstrap payload")
	}
	if meds, ok := payload["medications"].([]any); !ok || len(meds) == 0 {
		t.Fatalf("Expected non-empty medications in bootstrap payload")
	}
	if _, ok := payload["bp"].(map[string]any); !ok {
		t.Fatalf("Expected bp object in bootstrap payload")
	}
	if _, ok := payload["weight"].(map[string]any); !ok {
		t.Fatalf("Expected weight object in bootstrap payload")
	}
	if _, ok := payload["settings"].(map[string]any); !ok {
		t.Fatalf("Expected settings object in bootstrap payload")
	}
	if _, ok := payload["cursor"].(float64); !ok {
		t.Fatalf("Expected numeric cursor in bootstrap payload")
	}

	// Set a tab order and test again
	ctx := context.Background()
	_ = db.SetTabOrder(ctx, `["food","bp","workouts"]`)

	req2 := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req2 = withUser(req2, 123456)
	w2 := httptest.NewRecorder()
	srv.handleBootstrap(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w2.Code)
	}

	var payload2 map[string]any
	if err := json.NewDecoder(w2.Body).Decode(&payload2); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	settingsObj2, ok := payload2["settings"].(map[string]any)
	if !ok {
		t.Fatalf("Expected settings object in bootstrap payload2")
	}

	tabOrder, ok := settingsObj2["tab_order"].([]any)
	if !ok || len(tabOrder) != 3 {
		t.Fatalf("Expected tab_order array with 3 items")
	}
}

func TestHandleBootstrap_IncludesTodayFood(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Pre-existing food row eaten today in UTC (avoid near-midnight flakiness).
	nowUTC := time.Now().UTC()
	eatenAt := time.Date(nowUTC.Year(), nowUTC.Month(), nowUTC.Day(), 12, 0, 0, 0, time.UTC)
	if _, err := db.CreateFoodLog(context.Background(), &store.FoodLog{
		UserID:   123456,
		EatenAt:  eatenAt,
		Weight:   100,
		Calories: 250,
		Carbs:    30,
		Protein:  10,
		Fat:      5,
		Name:     "bootstrap test meal",
	}); err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/bootstrap?tz=UTC", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	food, ok := payload["food"].(map[string]any)
	if !ok {
		t.Fatalf("Expected food object in bootstrap payload, got %T (%v)", payload["food"], payload["food"])
	}
	dateStr, ok := food["date"].(string)
	if !ok || dateStr == "" {
		t.Fatalf("Expected food.date string, got %v", food["date"])
	}
	if got := time.Now().UTC().Format("2006-01-02"); dateStr != got {
		t.Fatalf("Expected food.date=%s, got %s", got, dateStr)
	}
	groups, ok := food["groups"].([]any)
	if !ok {
		t.Fatalf("Expected food.groups array, got %T", food["groups"])
	}
	if len(groups) == 0 {
		t.Fatalf("Expected at least one food group for today's eaten log")
	}
}

func TestHandleBootstrap_IncludesMedications(t *testing.T) {
	cases := []struct {
		name           string
		seed           func(t *testing.T, db *store.Store)
		wantNames      []string
		wantArchived   map[string]bool
		wantEmptySlice bool
	}{
		{
			name:           "empty user returns empty slice (not null)",
			seed:           func(t *testing.T, db *store.Store) {},
			wantNames:      nil,
			wantEmptySlice: true,
		},
		{
			name: "user with active meds",
			seed: func(t *testing.T, db *store.Store) {
				if _, err := db.CreateMedication("Active A", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("CreateMedication: %v", err)
				}
				if _, err := db.CreateMedication("Active B", "10mg", `{"type":"daily","times":["21:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("CreateMedication: %v", err)
				}
			},
			wantNames:    []string{"Active A", "Active B"},
			wantArchived: map[string]bool{"Active A": false, "Active B": false},
		},
		{
			name: "user with archived meds — bootstrap mirrors /api/medications?archived=true",
			seed: func(t *testing.T, db *store.Store) {
				if _, err := db.CreateMedication("Active Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("CreateMedication: %v", err)
				}
				archivedID, err := db.CreateMedication("Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
				if err != nil {
					t.Fatalf("CreateMedication: %v", err)
				}
				if err := db.UpdateMedication(archivedID, "Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, true, nil, nil, "", "", nil, ""); err != nil {
					t.Fatalf("UpdateMedication archive: %v", err)
				}
			},
			wantNames:    []string{"Active Med", "Archived Med"},
			wantArchived: map[string]bool{"Active Med": false, "Archived Med": true},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, db := createBPTestServer(t)
			defer db.Close()

			tc.seed(t, db)

			req := httptest.NewRequest("GET", "/api/bootstrap", nil)
			req = withUser(req, 123456)
			w := httptest.NewRecorder()
			srv.handleBootstrap(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("Expected status 200, got %d", w.Code)
			}

			raw := w.Body.Bytes()
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatalf("Decode payload: %v", err)
			}

			medsRaw, ok := payload["medications"]
			if !ok {
				t.Fatalf("Expected medications key in bootstrap payload")
			}

			if tc.wantEmptySlice {
				// Empty user must return [] (initialized slice), never null —
				// matches /api/medications behavior so clients can rely on a
				// stable array shape when seeding Dexie.
				if string(medsRaw) != "[]" {
					t.Fatalf("Expected medications=[], got %s", string(medsRaw))
				}
				return
			}

			var meds []store.Medication
			if err := json.Unmarshal(medsRaw, &meds); err != nil {
				t.Fatalf("Decode medications: %v", err)
			}

			if len(meds) != len(tc.wantNames) {
				t.Fatalf("Expected %d medications, got %d (%+v)", len(tc.wantNames), len(meds), meds)
			}

			gotByName := map[string]store.Medication{}
			for _, m := range meds {
				gotByName[m.Name] = m
			}
			for _, want := range tc.wantNames {
				if _, ok := gotByName[want]; !ok {
					t.Fatalf("Expected medication %q in bootstrap payload, got %+v", want, meds)
				}
			}
			for name, wantArchived := range tc.wantArchived {
				if got := gotByName[name].Archived; got != wantArchived {
					t.Errorf("medication %q: expected archived=%v, got %v", name, wantArchived, got)
				}
			}
		})
	}
}

// TestHandleBootstrap_MedicationsMatchesArchivedListEndpoint guards the
// invariant called out in the bootstrap inline comment: the medications array
// in /api/bootstrap must match /api/medications?archived=true so a client
// seeding Dexie from bootstrap stays in sync with the lazy fetch.
func TestHandleBootstrap_MedicationsMatchesArchivedListEndpoint(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if _, err := db.CreateMedication("Active Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	archivedID, err := db.CreateMedication("Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	if err := db.UpdateMedication(archivedID, "Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, true, nil, nil, "", "", nil, ""); err != nil {
		t.Fatalf("UpdateMedication archive: %v", err)
	}

	bootReq := httptest.NewRequest("GET", "/api/bootstrap", nil)
	bootReq = withUser(bootReq, 123456)
	bootW := httptest.NewRecorder()
	srv.handleBootstrap(bootW, bootReq)
	if bootW.Code != http.StatusOK {
		t.Fatalf("bootstrap: expected 200, got %d", bootW.Code)
	}
	var bootPayload struct {
		Medications []store.Medication `json:"medications"`
	}
	if err := json.Unmarshal(bootW.Body.Bytes(), &bootPayload); err != nil {
		t.Fatalf("Decode bootstrap: %v", err)
	}

	listReq := httptest.NewRequest("GET", "/api/medications?archived=true", nil)
	listReq = withUser(listReq, 123456)
	listW := httptest.NewRecorder()
	srv.handleListMedications(listW, listReq)
	if listW.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", listW.Code)
	}
	var listPayload []store.Medication
	if err := json.Unmarshal(listW.Body.Bytes(), &listPayload); err != nil {
		t.Fatalf("Decode list: %v", err)
	}

	if len(bootPayload.Medications) != len(listPayload) {
		t.Fatalf("medication count mismatch: bootstrap=%d list=%d", len(bootPayload.Medications), len(listPayload))
	}
	for i := range bootPayload.Medications {
		bm := bootPayload.Medications[i]
		lm := listPayload[i]
		if bm.ID != lm.ID || bm.Name != lm.Name || bm.Archived != lm.Archived {
			t.Errorf("entry %d differs: bootstrap=%+v list=%+v", i, bm, lm)
		}
	}
}

func TestHandleChanges(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	reqInitial := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	reqInitial = withUser(reqInitial, 123456)
	wInitial := httptest.NewRecorder()
	srv.handleChanges(wInitial, reqInitial)

	if wInitial.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", wInitial.Code)
	}

	var first map[string]any
	if err := json.NewDecoder(wInitial.Body).Decode(&first); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	cursor, ok := first["cursor"].(float64)
	if !ok {
		t.Fatalf("Expected numeric cursor")
	}

	// Simulate a write-side mutation in DB, should be captured by change_events trigger.
	if _, err := db.CreateBloodPressureReading(ctxWithUser(123456), &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}); err != nil {
		t.Fatalf("CreateBloodPressureReading failed: %v", err)
	}

	reqDelta := httptest.NewRequest("GET", "/api/changes?since="+strconv.FormatUint(uint64(cursor), 10), nil)
	reqDelta = withUser(reqDelta, 123456)
	wDelta := httptest.NewRecorder()
	srv.handleChanges(wDelta, reqDelta)

	if wDelta.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", wDelta.Code)
	}

	var second struct {
		Cursor      float64  `json:"cursor"`
		ChangedTags []string `json:"changed_tags"`
	}
	if err := json.NewDecoder(wDelta.Body).Decode(&second); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if second.Cursor <= cursor {
		t.Fatalf("Expected cursor to increase: before=%v after=%v", cursor, second.Cursor)
	}
	found := false
	for _, tag := range second.ChangedTags {
		if tag == "bp" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Expected changed_tags to include bp, got %v", second.ChangedTags)
	}
}

func TestHandleGetSettings_Timezone(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Initially no timezone recorded — should return empty string
	req := httptest.NewRequest("GET", "/api/settings", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	tz, ok := resp["timezone"].(string)
	if !ok {
		t.Fatalf("Expected timezone string in response")
	}
	if tz != "" {
		t.Fatalf("Expected empty timezone, got %q", tz)
	}
	serverTime, ok := resp["server_time"].(string)
	if !ok || serverTime == "" {
		t.Fatalf("Expected server_time string in response")
	}
	if _, err := time.Parse(time.RFC3339, serverTime); err != nil {
		t.Fatalf("Expected parseable RFC3339 server_time, got %q: %v", serverTime, err)
	}
	serverTimezone, ok := resp["server_timezone"].(string)
	if !ok || serverTimezone == "" {
		t.Fatalf("Expected server_timezone string in response")
	}

	// Record a timezone and verify it is returned
	if err := db.RecordTimezone("America/New_York"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	req2 := httptest.NewRequest("GET", "/api/settings", nil)
	req2 = withUser(req2, 123456)
	w2 := httptest.NewRecorder()
	srv.handleGetSettings(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w2.Code)
	}
	var resp2 map[string]any
	if err := json.NewDecoder(w2.Body).Decode(&resp2); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	tz2, ok := resp2["timezone"].(string)
	if !ok || tz2 != "America/New_York" {
		t.Fatalf("Expected America/New_York, got %q", tz2)
	}
	serverTime2, ok := resp2["server_time"].(string)
	if !ok || serverTime2 == "" {
		t.Fatalf("Expected server_time string in second response")
	}
}

func TestHandleUpdateSettings_ValidTimezone(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	tz, err := db.GetCurrentTimezone()
	if err != nil {
		t.Fatalf("GetCurrentTimezone: %v", err)
	}
	if tz != "Asia/Tokyo" {
		t.Fatalf("Expected Asia/Tokyo, got %q", tz)
	}
}

func TestHandleUpdateSettings_InvalidTimezone(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"timezone": "Not/ATimezone"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected status 400, got %d", w.Code)
	}
}

// TestHandleUpdateSettings_GeneratesTransitionPlan is the end-to-end regression
// guard for the web → tzupdate.Service → tzreschedule.PlannerService flow.
// After SetTZPlanner wires a real planner, an actual timezone change must:
//   - persist the new timezone, AND
//   - leave a PENDING_APPROVAL plan in the store for the medication scheduler
//     to honour until the user approves the stepped transition.
//
// This pins the parity between the web path and the bot path (Task 4); a
// regression in either transport's wiring through tzupdate.Service would let
// the new timezone land without a plan, silently shifting doses by the offset
// delta on the next scheduler tick.
func TestHandleUpdateSettings_GeneratesTransitionPlan(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if err := db.RecordTimezone("America/New_York"); err != nil {
		t.Fatalf("seed RecordTimezone: %v", err)
	}
	if _, err := db.CreateMedication("Daily Med", "5mg", `{"type":"daily","times":["08:00","20:00"]}`, nil, nil, "", "", "medium"); err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	srv.SetTZPlanner(tzreschedule.NewPlannerService(db))

	body, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	tz, err := db.GetCurrentTimezone()
	if err != nil {
		t.Fatalf("GetCurrentTimezone: %v", err)
	}
	if tz != "Asia/Tokyo" {
		t.Fatalf("Expected stored timezone Asia/Tokyo, got %q", tz)
	}

	plan, err := db.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if plan == nil {
		t.Fatalf("Expected a PENDING_APPROVAL plan after timezone change, got nil")
	}
	if plan.Status != "PENDING_APPROVAL" {
		t.Errorf("Expected plan.Status=PENDING_APPROVAL, got %q", plan.Status)
	}
	if plan.OldTZ != "America/New_York" || plan.NewTZ != "Asia/Tokyo" {
		t.Errorf("Expected plan OldTZ=America/New_York NewTZ=Asia/Tokyo, got OldTZ=%q NewTZ=%q",
			plan.OldTZ, plan.NewTZ)
	}
}

// TestHandleUpdateSettings_UsesInjectedTZUpdater asserts the handler delegates
// to the tzUpdater service rather than calling RecordTimezone directly. A
// stub service captures the call and short-circuits persistence; the test
// verifies the new timezone never reaches the store, proving the handler
// goes through the service.
func TestHandleUpdateSettings_UsesInjectedTZUpdater(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	stub := &stubTZUpdater{}
	srv.SetTZUpdater(stub)

	body, _ := json.Marshal(map[string]string{"timezone": "Europe/Berlin"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if len(stub.calls) != 1 || stub.calls[0] != "Europe/Berlin" {
		t.Errorf("Expected exactly one UpdateTimezone(Europe/Berlin) call, got %v", stub.calls)
	}
	// The stub did NOT call RecordTimezone, so the store must still be empty.
	if tz, _ := db.GetCurrentTimezone(); tz != "" {
		t.Errorf("Expected store untouched (empty), got %q — handler bypassed the service", tz)
	}
}

type stubTZUpdater struct {
	calls       []string
	planCreated bool
	err         error
}

func (s *stubTZUpdater) UpdateTimezone(_ context.Context, newTZ string) (bool, error) {
	s.calls = append(s.calls, newTZ)
	return s.planCreated, s.err
}

func TestHandleBootstrap_IncludesTimezone(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if err := db.RecordTimezone("Europe/Berlin"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}
	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	settings, ok := payload["settings"].(map[string]any)
	if !ok {
		t.Fatalf("Expected settings object in bootstrap")
	}
	tz, ok := settings["timezone"].(string)
	if !ok || tz != "Europe/Berlin" {
		t.Fatalf("Expected Europe/Berlin in bootstrap settings timezone, got %q", tz)
	}
}

func TestHandleSetTabOrder(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Initial value should be empty
	order, _ := db.GetTabOrder(ctx)
	if order != "" {
		t.Fatalf("expected empty tab order")
	}

	// Set valid tab order
	reqBody := map[string]interface{}{"order": []string{"food", "bp", "weight"}}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/settings/tab-order", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleSetTabOrder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	order, _ = db.GetTabOrder(ctx)
	if order != `["food","bp","weight"]` {
		t.Fatalf("Expected '[\"food\",\"bp\",\"weight\"]', got '%s'", order)
	}

	// Try setting invalid tab order
	reqBodyInvalid := map[string]interface{}{"order": []string{"invalid_tab"}}
	bodyInvalid, _ := json.Marshal(reqBodyInvalid)
	reqInvalid := httptest.NewRequest("POST", "/api/settings/tab-order", bytes.NewReader(bodyInvalid))
	reqInvalid = withUser(reqInvalid, 123456)
	wInvalid := httptest.NewRecorder()
	srv.handleSetTabOrder(wInvalid, reqInvalid)

	if wInvalid.Code != http.StatusBadRequest {
		t.Fatalf("Expected status 400, got %d", wInvalid.Code)
	}
}
