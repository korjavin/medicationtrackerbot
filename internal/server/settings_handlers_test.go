package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
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

	enabled, err := db.Settings.GetBloodPressureEnabled(context.Background())
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

	if _, err := db.Medication.Create("Bootstrap Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
		t.Fatalf("Create failed: %v", err)
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
	_ = db.Settings.SetTabOrder(ctx, `["food","bp","workouts"]`)

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
	if _, err := db.Food.CreateLog(context.Background(), &store.FoodLog{
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
				if _, err := db.Medication.Create("Active A", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("Create: %v", err)
				}
				if _, err := db.Medication.Create("Active B", "10mg", `{"type":"daily","times":["21:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("Create: %v", err)
				}
			},
			wantNames:    []string{"Active A", "Active B"},
			wantArchived: map[string]bool{"Active A": false, "Active B": false},
		},
		{
			name: "user with archived meds — bootstrap mirrors /api/medications?archived=true",
			seed: func(t *testing.T, db *store.Store) {
				if _, err := db.Medication.Create("Active Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
					t.Fatalf("Create: %v", err)
				}
				archivedID, err := db.Medication.Create("Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
				if err != nil {
					t.Fatalf("Create: %v", err)
				}
				if err := db.Medication.Update(archivedID, "Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, true, nil, nil, "", "", nil, ""); err != nil {
					t.Fatalf("Update archive: %v", err)
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

	if _, err := db.Medication.Create("Active Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	archivedID, err := db.Medication.Create("Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.Update(archivedID, "Archived Med", "20mg", `{"type":"daily","times":["08:00"]}`, true, nil, nil, "", "", nil, ""); err != nil {
		t.Fatalf("Update archive: %v", err)
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
	if _, err := db.BP.CreateReading(ctxWithUser(123456), &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}); err != nil {
		t.Fatalf("CreateReading failed: %v", err)
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
	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("Record: %v", err)
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

	tz, err := db.TZ.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
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

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("seed Record: %v", err)
	}
	if _, err := db.Medication.Create("Daily Med", "5mg", `{"type":"daily","times":["08:00","20:00"]}`, nil, nil, "", "", "medium"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	srv.SetTZUpdater(tzupdate.NewService(db.TZ, db.TZ, tzreschedule.NewPlannerService(&testTZPlannerStore{db}), nil, nil))

	body, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	tz, err := db.TZ.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
	}
	if tz != "Asia/Tokyo" {
		t.Fatalf("Expected stored timezone Asia/Tokyo, got %q", tz)
	}

	plan, err := db.TZ.GetLatestActiveOrPendingTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTransitionPlan: %v", err)
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

func TestHandleBootstrap_IncludesTimezone(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if err := db.TZ.Record("Europe/Berlin"); err != nil {
		t.Fatalf("Record: %v", err)
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

// TestHandleGetSettings_FullBundle is the regression guard for Task 7 of the
// offline-sections-sweep plan: GET /api/settings now returns the same shape
// the bootstrap response embeds, so opening the Settings screen refreshes
// every toggle in one round-trip. Each sub-case pins one slice of the bundle
// (features map, food targets, reminder status flags, tab order, weight unit
// preference) so a regression in any single field is unambiguous.
func TestHandleGetSettings_FullBundle(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	ctx := context.Background()
	const userID = int64(123456)

	// Seed every slice of the bundle so each sub-case has a non-default value
	// to assert against. Defaults would still produce a 200, but they don't
	// distinguish "field was wired up" from "field was dropped silently".
	if err := db.TZ.Record("Europe/Berlin"); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := db.Weight.SetUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}
	if err := db.Settings.SetBloodPressureEnabled(ctx, false); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}
	if err := db.Food.SetTargets(ctx, store.FoodTargets{Calories: 2000, Carbs: 200, Protein: 150, Fat: 70}); err != nil {
		t.Fatalf("SetFoodTargets: %v", err)
	}
	if _, err := db.BP.GetReminderState(userID); err != nil { // creates default row
		t.Fatalf("seed GetReminderState: %v", err)
	}
	if err := db.BP.SetReminderEnabled(userID, false); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}
	if _, err := db.Weight.GetReminderState(userID); err != nil { // creates default row
		t.Fatalf("seed GetWeightReminderState: %v", err)
	}
	if err := db.Settings.SetTabOrder(ctx, `["food","bp","weight"]`); err != nil {
		t.Fatalf("SetTabOrder: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/settings", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	cases := []struct {
		name   string
		assert func(t *testing.T)
	}{
		{
			name: "timezone preserved",
			assert: func(t *testing.T) {
				tz, _ := resp["timezone"].(string)
				if tz != "Europe/Berlin" {
					t.Errorf("Expected timezone=Europe/Berlin, got %q", tz)
				}
			},
		},
		{
			name: "server_time is RFC3339",
			assert: func(t *testing.T) {
				st, _ := resp["server_time"].(string)
				if st == "" {
					t.Fatalf("Expected non-empty server_time")
				}
				if _, err := time.Parse(time.RFC3339, st); err != nil {
					t.Errorf("Expected RFC3339 server_time, got %q: %v", st, err)
				}
			},
		},
		{
			name: "server_timezone non-empty",
			assert: func(t *testing.T) {
				if stz, _ := resp["server_timezone"].(string); stz == "" {
					t.Errorf("Expected non-empty server_timezone")
				}
			},
		},
		{
			name: "weight_unit_preference reflects stored value",
			assert: func(t *testing.T) {
				if u, _ := resp["weight_unit_preference"].(string); u != "lb" {
					t.Errorf("Expected weight_unit_preference=lb, got %q", u)
				}
			},
		},
		{
			name: "features map mirrors bootstrap shape",
			assert: func(t *testing.T) {
				features, ok := resp["features"].(map[string]any)
				if !ok {
					t.Fatalf("Expected features map, got %T", resp["features"])
				}
				bp, ok := features["bp"].(bool)
				if !ok {
					t.Fatalf("Expected features.bp bool, got %T", features["bp"])
				}
				if bp {
					t.Errorf("Expected features.bp=false after SetBloodPressureEnabled(false)")
				}
				// Sanity: the rest of the canonical bootstrap features are present.
				for _, key := range []string{"food", "weight", "medication", "workout", "health"} {
					if _, ok := features[key]; !ok {
						t.Errorf("Expected features.%s present in response", key)
					}
				}
			},
		},
		{
			name: "food_targets carries macro values",
			assert: func(t *testing.T) {
				ft, ok := resp["food_targets"].(map[string]any)
				if !ok {
					t.Fatalf("Expected food_targets map, got %T", resp["food_targets"])
				}
				if cals, _ := ft["calories"].(float64); cals != 2000 {
					t.Errorf("Expected food_targets.calories=2000, got %v", ft["calories"])
				}
				if carbs, _ := ft["carbs"].(float64); carbs != 200 {
					t.Errorf("Expected food_targets.carbs=200, got %v", ft["carbs"])
				}
				if pro, _ := ft["protein"].(float64); pro != 150 {
					t.Errorf("Expected food_targets.protein=150, got %v", ft["protein"])
				}
				if fat, _ := ft["fat"].(float64); fat != 70 {
					t.Errorf("Expected food_targets.fat=70, got %v", ft["fat"])
				}
			},
		},
		{
			name: "bp_reminder_status reflects toggled-off state",
			assert: func(t *testing.T) {
				bpRem, ok := resp["bp_reminder_status"].(map[string]any)
				if !ok {
					t.Fatalf("Expected bp_reminder_status map, got %T", resp["bp_reminder_status"])
				}
				enabled, ok := bpRem["enabled"].(bool)
				if !ok {
					t.Fatalf("Expected bp_reminder_status.enabled bool")
				}
				if enabled {
					t.Errorf("Expected bp_reminder_status.enabled=false")
				}
			},
		},
		{
			name: "weight_reminder_status present with default enabled=true",
			assert: func(t *testing.T) {
				wRem, ok := resp["weight_reminder_status"].(map[string]any)
				if !ok {
					t.Fatalf("Expected weight_reminder_status map, got %T", resp["weight_reminder_status"])
				}
				enabled, ok := wRem["enabled"].(bool)
				if !ok {
					t.Fatalf("Expected weight_reminder_status.enabled bool")
				}
				// Default created by GetWeightReminderState is enabled=true; no
				// SetWeightReminderEnabled call followed it, so the response
				// should carry that default.
				if !enabled {
					t.Errorf("Expected weight_reminder_status.enabled=true (default)")
				}
			},
		},
		{
			name: "tab_order parsed from stored JSON",
			assert: func(t *testing.T) {
				rawOrder, ok := resp["tab_order"].([]any)
				if !ok {
					t.Fatalf("Expected tab_order array, got %T", resp["tab_order"])
				}
				if len(rawOrder) != 3 {
					t.Fatalf("Expected 3 tabs in tab_order, got %d", len(rawOrder))
				}
				want := []string{"food", "bp", "weight"}
				for i, s := range want {
					if got, _ := rawOrder[i].(string); got != s {
						t.Errorf("tab_order[%d]: expected %q, got %q", i, s, got)
					}
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, tc.assert)
	}
}

// TestHandleGetSettings_NoUser confirms the bundle handler degrades gracefully
// when the auth middleware did not attach a TelegramUser to the context (e.g.
// pre-login bootstrap probe). The route is auth-gated upstream, but the
// handler must still avoid a nil-deref on the user-scoped reminder reads.
func TestHandleGetSettings_NoUser(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/settings", nil) // no withUser
	w := httptest.NewRecorder()
	srv.handleGetSettings(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if _, ok := resp["timezone"]; !ok {
		t.Errorf("Expected timezone key even without user")
	}
	if _, ok := resp["features"]; !ok {
		t.Errorf("Expected features key even without user")
	}
	if resp["bp_reminder_status"] != nil {
		t.Errorf("Expected bp_reminder_status=null when user missing, got %v", resp["bp_reminder_status"])
	}
	if resp["weight_reminder_status"] != nil {
		t.Errorf("Expected weight_reminder_status=null when user missing, got %v", resp["weight_reminder_status"])
	}
}

// TestHandleGetSettings_TabOrderOmittedWhenUnset confirms that absent tab_order
// data is omitted from the response (matching bootstrap's behaviour). Clients
// preserve their local fallback when the key is missing rather than reseting
// to an empty array.
func TestHandleGetSettings_TabOrderOmittedWhenUnset(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

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
	if _, present := resp["tab_order"]; present {
		t.Errorf("Expected tab_order to be omitted when unset, got %v", resp["tab_order"])
	}
}

func TestHandleSetTabOrder(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Initial value should be empty
	order, _ := db.Settings.GetTabOrder(ctx)
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

	order, _ = db.Settings.GetTabOrder(ctx)
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

// TestTZSuggestionDismiss_BundleRoundTrip is the cross-client dismissal
// integration guard: a POST to /api/tz-suggestion/dismiss must persist the
// detected TZ so a subsequent GET /api/settings reports the same value, and a
// follow-up TZ change via POST /api/settings must clear the dismissal so the
// next genuine TZ mismatch prompts normally.
func TestTZSuggestionDismiss_BundleRoundTrip(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()
	const userID = int64(123456)

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("seed Record: %v", err)
	}

	// Dismiss the detected TZ via the new endpoint.
	body, _ := json.Marshal(map[string]string{"detected_tz": "Asia/Tokyo"})
	req := httptest.NewRequest("POST", "/api/tz-suggestion/dismiss", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleTZSuggestionDismiss(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("dismiss: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// GET /api/settings must reflect the dismissal in the bundle.
	getReq := httptest.NewRequest("GET", "/api/settings", nil)
	getReq = withUser(getReq, userID)
	getW := httptest.NewRecorder()
	srv.handleGetSettings(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("get settings: expected 200, got %d", getW.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(getW.Body).Decode(&resp); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if got, _ := resp["dismissed_tz_suggestion"].(string); got != "Asia/Tokyo" {
		t.Fatalf("expected dismissed_tz_suggestion=Asia/Tokyo after dismiss, got %q", got)
	}

	// Wire the tz updater with a planner so POST /api/settings exercises the
	// full Record path (which clears the dismissed flag in the same
	// transaction).
	srv.SetTZUpdater(tzupdate.NewService(db.TZ, db.TZ, tzreschedule.NewPlannerService(&testTZPlannerStore{db}), nil, nil))

	// Now record a new TZ via POST /api/settings — the same TZ the user had
	// dismissed. This must clear the dismissal so the next mismatch prompts
	// normally.
	updateBody, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	updateReq := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(updateBody))
	updateReq = withUser(updateReq, userID)
	updateW := httptest.NewRecorder()
	srv.handleUpdateSettings(updateW, updateReq)
	if updateW.Code != http.StatusOK {
		t.Fatalf("update settings: expected 200, got %d. Body: %s", updateW.Code, updateW.Body.String())
	}

	// Re-fetch the bundle and assert the dismissed flag is gone.
	getReq2 := httptest.NewRequest("GET", "/api/settings", nil)
	getReq2 = withUser(getReq2, userID)
	getW2 := httptest.NewRecorder()
	srv.handleGetSettings(getW2, getReq2)
	var resp2 map[string]any
	if err := json.NewDecoder(getW2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode settings after update: %v", err)
	}
	if got, _ := resp2["dismissed_tz_suggestion"].(string); got != "" {
		t.Fatalf("expected dismissed_tz_suggestion cleared after Record, got %q", got)
	}
}

// TestTZSuggestionDismiss_InvalidTZ confirms the dismiss endpoint rejects
// non-IANA timezone strings with 400, matching the validation in the
// tzsuggestion domain service.
func TestTZSuggestionDismiss_InvalidTZ(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"detected_tz": "Not/ATimezone"})
	req := httptest.NewRequest("POST", "/api/tz-suggestion/dismiss", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleTZSuggestionDismiss(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid TZ, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// TestHandleUpdateSettings_NotifiesOnTimezoneChange is the integration guard for
// the web-accept-confirms-via-chat flow: when the user changes their timezone
// through POST /api/settings, the server must fire exactly one informational
// notification (per configured notifier) carrying the new TZ in the text. The
// dismiss endpoint must stay silent.
func TestHandleUpdateSettings_NotifiesOnTimezoneChange(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("seed Record: %v", err)
	}
	// Use the default tzUpdater (no planner) — we want to assert the
	// notification fires whenever the stored TZ changes, regardless of
	// whether a transition plan was generated. Plan-created text is
	// covered by behaviour, not asserted here.

	mock := &mockNotifier{}
	srv.SetNotifiers([]notifier.Notifier{mock})

	body, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	req := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateSettings(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// s.notify dispatches via a goroutine, so wait for the worker to record
	// the call rather than racing it.
	var sent []string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sent = mock.Sent()
		if len(sent) >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(sent) != 1 {
		t.Fatalf("expected exactly 1 notification on TZ accept, got %d: %v", len(sent), sent)
	}
	if !strings.Contains(sent[0], "Asia/Tokyo") {
		t.Errorf("expected notification text to mention Asia/Tokyo, got %q", sent[0])
	}

	// A no-op POST /api/settings with the same TZ must NOT fire another
	// notification — the tzupdate service short-circuits old==new writes.
	noopBody, _ := json.Marshal(map[string]string{"timezone": "Asia/Tokyo"})
	noopReq := httptest.NewRequest("POST", "/api/settings", bytes.NewReader(noopBody))
	noopReq = withUser(noopReq, 123456)
	noopW := httptest.NewRecorder()
	srv.handleUpdateSettings(noopW, noopReq)
	if noopW.Code != http.StatusOK {
		t.Fatalf("no-op update: expected 200, got %d", noopW.Code)
	}
	// Give any (incorrect) goroutine a moment to land.
	time.Sleep(50 * time.Millisecond)
	if got := len(mock.Sent()); got != 1 {
		t.Errorf("expected no-op TZ write to fire 0 additional notifications, total now %d: %v", got, mock.Sent())
	}

	// Dismiss path must NOT trigger a notification.
	dismissBody, _ := json.Marshal(map[string]string{"detected_tz": "Europe/Paris"})
	dismissReq := httptest.NewRequest("POST", "/api/tz-suggestion/dismiss", bytes.NewReader(dismissBody))
	dismissReq = withUser(dismissReq, 123456)
	dismissW := httptest.NewRecorder()
	srv.handleTZSuggestionDismiss(dismissW, dismissReq)
	if dismissW.Code != http.StatusOK {
		t.Fatalf("dismiss: expected 200, got %d. Body: %s", dismissW.Code, dismissW.Body.String())
	}
	time.Sleep(50 * time.Millisecond)
	if got := len(mock.Sent()); got != 1 {
		t.Errorf("expected dismiss to fire 0 notifications, total now %d: %v", got, mock.Sent())
	}
}
