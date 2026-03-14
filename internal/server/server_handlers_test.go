package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func createGenericTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	return srv, db
}

func TestServeConfigJS(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/static/config.js", nil)
	w := httptest.NewRecorder()

	srv.serveConfigJS(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/javascript" {
		t.Errorf("Expected application/javascript, got %q", ct)
	}

	body := w.Body.String()
	if !strings.Contains(body, "window.BOT_USERNAME") {
		t.Errorf("Body missing window.BOT_USERNAME: %s", body)
	}
	if !strings.Contains(body, "window.OIDC_CONFIG") {
		t.Errorf("Body missing window.OIDC_CONFIG: %s", body)
	}
}

// --- Restock handlers ---

func TestHandleRestock(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")
	count := 10
	db.SetInventory(medID, &count)

	reqBody := map[string]interface{}{
		"quantity": 20,
		"note":     "Monthly refill",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d/restock", medID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleRestock(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["status"] != "restocked" {
		t.Errorf("Expected status 'restocked', got %v", resp["status"])
	}
	if resp["quantity_added"] != float64(20) {
		t.Errorf("Expected quantity_added 20, got %v", resp["quantity_added"])
	}

	// Verify DB
	med, _ := db.GetMedication(medID)
	if med.InventoryCount == nil || *med.InventoryCount != 30 {
		t.Errorf("Expected inventory 30, got %v", med.InventoryCount)
	}
}

func TestHandleRestock_InvalidQuantity(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")

	reqBody := map[string]interface{}{"quantity": 0}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d/restock", medID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleRestock(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for zero quantity, got %d", w.Code)
	}
}

func TestHandleGetRestockHistory(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")
	db.AddRestock(medID, 30, "Initial")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/medications/%d/restocks", medID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleGetRestockHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var restocks []store.Restock
	json.NewDecoder(w.Body).Decode(&restocks)

	if len(restocks) != 1 {
		t.Fatalf("Expected 1 restock, got %d", len(restocks))
	}
	if restocks[0].Quantity != 30 {
		t.Errorf("Expected quantity 30, got %d", restocks[0].Quantity)
	}
}

func TestHandleGetLowStock(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Create a medication with low stock
	medID, _ := db.CreateMedication("LowMed", "10mg", `{"type":"daily","times":["09:00","21:00"]}`, nil, nil, "", "")
	count := 3
	db.SetInventory(medID, &count)

	req := httptest.NewRequest("GET", "/api/inventory/low?days=7", nil)
	w := httptest.NewRecorder()

	srv.handleGetLowStock(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var result []map[string]interface{}
	json.NewDecoder(w.Body).Decode(&result)

	if len(result) == 0 {
		t.Error("Expected at least 1 low stock medication")
	}
}

// --- Push subscription handlers ---

func TestHandleSubscribePush(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{
		"endpoint": "https://push.example.com/test",
		"keys": map[string]string{
			"auth":   "test-auth-key",
			"p256dh": "test-p256dh-key",
		},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/webpush/subscribe", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSubscribePush(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify in DB
	subs, _ := db.GetPushSubscriptions(123456)
	if len(subs) != 1 {
		t.Fatalf("Expected 1 subscription, got %d", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/test" {
		t.Errorf("Expected endpoint, got %q", subs[0].Endpoint)
	}
}

func TestHandleUnsubscribePush(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Create subscription first
	db.CreatePushSubscription(123456, "https://push.example.com/test", "auth", "p256dh")

	reqBody := map[string]interface{}{
		"endpoint": "https://push.example.com/test",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/webpush/unsubscribe", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleUnsubscribePush(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	subs, _ := db.GetPushSubscriptions(123456)
	if len(subs) != 0 {
		t.Errorf("Expected 0 subscriptions after unsubscribe, got %d", len(subs))
	}
}

func TestHandleListPushSubscriptions(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	db.CreatePushSubscription(123456, "https://push.example.com/1", "auth1", "p256dh1")
	db.CreatePushSubscription(123456, "https://push.example.com/2", "auth2", "p256dh2")

	req := httptest.NewRequest("GET", "/api/webpush/subscriptions", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListPushSubscriptions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var subs []store.PushSubscription
	json.NewDecoder(w.Body).Decode(&subs)

	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions, got %d", len(subs))
	}
}

// --- Confirm schedule handler ---

func TestHandleConfirmSchedule_WithIntakeIDs(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")
	count := 10
	db.SetInventory(medID, &count)

	schedTime := time.Now()
	intakeID, _ := db.CreateIntake(medID, userID, schedTime)

	reqBody := map[string]interface{}{
		"intake_ids": []int64{intakeID},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/confirm-schedule", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleConfirmSchedule(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify intake confirmed
	intake, _ := db.GetIntake(intakeID)
	if intake.Status != "TAKEN" {
		t.Errorf("Expected status TAKEN, got %s", intake.Status)
	}

	// Verify inventory decremented
	med, _ := db.GetMedication(medID)
	if med.InventoryCount == nil || *med.InventoryCount != 9 {
		t.Errorf("Expected inventory 9, got %v", med.InventoryCount)
	}
}

// --- Log past intake handler ---

func TestHandleLogPastIntake(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")

	takenAt := time.Now().Add(-2 * time.Hour)
	reqBody := map[string]interface{}{
		"medication_id": medID,
		"taken_at":      takenAt.Format(time.RFC3339),
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/log-past", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleLogPastIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify in DB
	history, _ := db.GetIntakeHistory(int(medID), 1)
	if len(history) == 0 {
		t.Error("Expected at least 1 intake in history")
	}
}

// --- Weight reminder handlers ---

func TestHandleGetWeightReminderStatus(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/weight/reminder/status", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetWeightReminderStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	// Default state should have enabled field
	if _, ok := resp["enabled"]; !ok {
		t.Error("Expected 'enabled' field in response")
	}
}

func TestHandleToggleWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{"enabled": true}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/weight/reminder/toggle", bytes.NewReader(body))
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleToggleWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify state
	state, _ := db.GetWeightReminderState(123456)
	if !state.Enabled {
		t.Error("Expected weight reminder to be enabled")
	}
}

func TestHandleSnoozeWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	// Enable first
	db.SetWeightReminderEnabled(123456, true)

	req := httptest.NewRequest("POST", "/api/weight/reminder/snooze", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSnoozeWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	state, _ := db.GetWeightReminderState(123456)
	if state.SnoozedUntil == nil {
		t.Error("Expected snooze to be set")
	}
}

func TestHandleDontBugMeWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	db.SetWeightReminderEnabled(123456, true)

	req := httptest.NewRequest("POST", "/api/weight/reminder/dontbug", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDontBugMeWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	state, _ := db.GetWeightReminderState(123456)
	if state.DontRemindUntil == nil {
		t.Error("Expected dont-remind-until to be set")
	}
}

// --- Food handler extensions ---

func TestHandleUpdateFoodLog(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	logID, _ := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Original",
		Weight:   100,
		Calories: 200,
		Carbs:    30,
		Protein:  10,
		Fat:      5,
	})

	reqBody := map[string]interface{}{
		"eaten_at": time.Now().Format(time.RFC3339),
		"name":     "Updated",
		"weight":   150,
		"calories": 300,
		"carbs":    40,
		"protein":  15,
		"fat":      10,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("PUT", fmt.Sprintf("/api/food/log/%d", logID), bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", logID))
	w := httptest.NewRecorder()

	srv.handleUpdateFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetFoodStats(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Meal",
		Weight:   200,
		Calories: 500,
		Carbs:    60,
		Protein:  30,
		Fat:      20,
	})

	today := time.Now().Format("2006-01-02")
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/food/stats?date=%s&days=1", today), nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodStats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var stats store.FoodStats
	json.NewDecoder(w.Body).Decode(&stats)

	if stats.Calories != 500 {
		t.Errorf("Expected 500 calories, got %d", stats.Calories)
	}
}

func TestHandleGetFoodTargets(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	db.SetFoodTargets(context.Background(), store.FoodTargets{
		Calories: 2000, Carbs: 250, Protein: 100, Fat: 70,
	})

	req := httptest.NewRequest("GET", "/api/food/settings/targets", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodTargets(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var targets store.FoodTargets
	json.NewDecoder(w.Body).Decode(&targets)

	if targets.Calories != 2000 {
		t.Errorf("Expected 2000 calories, got %d", targets.Calories)
	}
}

func TestHandleSetFoodTargets(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	reqBody := store.FoodTargets{Calories: 1800, Carbs: 200, Protein: 90, Fat: 60}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/settings/targets", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSetFoodTargets(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify
	targets, _ := db.GetFoodTargets(context.Background())
	if targets.Calories != 1800 {
		t.Errorf("Expected 1800, got %d", targets.Calories)
	}
}

func TestHandleGetFoodProducts(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.UpsertFoodProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "Apple",
		Carbs100g:      14,
		Protein100g:    0.3,
		Fat100g:        0.2,
		EnergyKcal100g: 52,
	})

	req := httptest.NewRequest("GET", "/api/food/products", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodProducts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var response struct {
		Products []store.FoodProduct `json:"products"`
		Total    int                 `json:"total"`
	}
	json.NewDecoder(w.Body).Decode(&response)

	if len(response.Products) == 0 {
		t.Error("Expected at least 1 product")
	}
	if response.Total == 0 {
		t.Error("Expected total > 0")
	}
}

func TestHandleUpdateFoodProduct(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.UpsertFoodProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "Apple",
		Carbs100g:      14,
		Protein100g:    0.3,
		Fat100g:        0.2,
		EnergyKcal100g: 52,
	})

	products, _, _ := db.GetFoodProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	if len(products) == 0 {
		t.Fatal("Expected at least 1 product")
	}
	productID := products[0].ID

	reqBody := map[string]interface{}{
		"name":             "Green Apple",
		"carbs_100g":       12,
		"protein_100g":     0.3,
		"fat_100g":         0.1,
		"energy_kcal_100g": 48,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("PUT", fmt.Sprintf("/api/food/products/%d", productID), bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", productID))
	w := httptest.NewRecorder()

	srv.handleUpdateFoodProduct(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleDeleteFoodProduct(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.UpsertFoodProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "ToDelete",
		Carbs100g:      10,
		Protein100g:    1,
		Fat100g:        0.5,
		EnergyKcal100g: 40,
	})

	products, _, _ := db.GetFoodProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	productID := products[0].ID

	req := httptest.NewRequest("DELETE", fmt.Sprintf("/api/food/products/%d", productID), nil)
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", productID))
	w := httptest.NewRecorder()

	srv.handleDeleteFoodProduct(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	products, _, _ = db.GetFoodProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	if len(products) != 0 {
		t.Errorf("Expected 0 products after delete, got %d", len(products))
	}
}

// --- Workout group/variant/exercise CRUD ---

func TestHandleWorkoutGroupCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)

	// Create group
	reqBody := map[string]interface{}{
		"name":                         "Push Pull",
		"description":                  "PPL Split",
		"is_rotating":                  true,
		"days_of_week":                 "[1,3,5]",
		"scheduled_time":               "18:00",
		"notification_advance_minutes": 15,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/groups/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateWorkoutGroup(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create group: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var createResp store.WorkoutGroup
	json.NewDecoder(w.Body).Decode(&createResp)
	groupID := createResp.ID
	if groupID == 0 {
		t.Fatal("Expected non-zero group ID")
	}

	// List groups
	req = httptest.NewRequest("GET", "/api/workout/groups", nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListWorkoutGroups(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List groups: expected 200, got %d", w.Code)
	}

	var groups []store.WorkoutGroup
	json.NewDecoder(w.Body).Decode(&groups)
	if len(groups) != 1 {
		t.Fatalf("Expected 1 group, got %d", len(groups))
	}

	// Update group
	updateBody := map[string]interface{}{
		"name":                         "Updated PPL",
		"description":                  "Updated",
		"is_rotating":                  true,
		"days_of_week":                 "[1,2,3,4,5]",
		"scheduled_time":               "19:00",
		"notification_advance_minutes": 30,
		"active":                       true,
	}
	body, _ = json.Marshal(updateBody)
	req = httptest.NewRequest("PUT", fmt.Sprintf("/api/workout/groups/update?id=%d", groupID), bytes.NewReader(body))
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleUpdateWorkoutGroup(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Update group: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify update
	group, _ := db.GetWorkoutGroup(groupID)
	if group.Name != "Updated PPL" {
		t.Errorf("Expected 'Updated PPL', got %q", group.Name)
	}
}

func TestHandleWorkoutVariantCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)

	// Create variant
	reqBody := map[string]interface{}{
		"group_id":    group.ID,
		"name":        "Variant A",
		"description": "First variant",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/variants/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateWorkoutVariant(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create variant: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var variant store.WorkoutVariant
	json.NewDecoder(w.Body).Decode(&variant)
	if variant.ID == 0 {
		t.Fatal("Expected non-zero variant ID")
	}

	// List variants
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/workout/variants?group_id=%d", group.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListVariantsByGroup(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List variants: expected 200, got %d", w.Code)
	}

	var variants []store.WorkoutVariant
	json.NewDecoder(w.Body).Decode(&variants)
	if len(variants) != 1 {
		t.Errorf("Expected 1 variant, got %d", len(variants))
	}

	// Update variant
	updateBody := map[string]interface{}{
		"name":        "Updated A",
		"description": "Updated",
	}
	body, _ = json.Marshal(updateBody)
	req = httptest.NewRequest("PUT", fmt.Sprintf("/api/workout/variants/update?id=%d", variant.ID), bytes.NewReader(body))
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleUpdateWorkoutVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Update variant: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Delete variant
	req = httptest.NewRequest("DELETE", fmt.Sprintf("/api/workout/variants/delete?id=%d", variant.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleDeleteWorkoutVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Delete variant: expected 200, got %d", w.Code)
	}
}

func TestHandleWorkoutExerciseCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant A", &order, "")

	// Create exercise
	reqBody := map[string]interface{}{
		"variant_id":      variant.ID,
		"exercise_name":   "Bench Press",
		"target_sets":     3,
		"target_reps_min": 8,
		"order_index":     0,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/exercises/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateExercise(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create exercise: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var exercise store.WorkoutExercise
	json.NewDecoder(w.Body).Decode(&exercise)
	if exercise.ID == 0 {
		t.Fatal("Expected non-zero exercise ID")
	}

	// List exercises
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/workout/exercises?variant_id=%d", variant.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListExercisesByVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List exercises: expected 200, got %d", w.Code)
	}

	var exercises []store.WorkoutExercise
	json.NewDecoder(w.Body).Decode(&exercises)
	if len(exercises) != 1 {
		t.Errorf("Expected 1 exercise, got %d", len(exercises))
	}

	// Delete exercise
	req = httptest.NewRequest("DELETE", fmt.Sprintf("/api/workout/exercises/delete?id=%d", exercise.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleDeleteExercise(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Delete exercise: expected 200, got %d", w.Code)
	}
}

// --- Session management ---

func TestHandleStartWorkoutSession(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/workout/sessions/%d/start", session.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", session.ID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleStartWorkoutSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	s, _ := db.GetWorkoutSession(session.ID)
	if s.Status != "in_progress" {
		t.Errorf("Expected status 'in_progress', got %q", s.Status)
	}
}

func TestHandleSkipWorkoutSession(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/workout/sessions/%d/skip", session.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", session.ID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleSkipWorkoutSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	s, _ := db.GetWorkoutSession(session.ID)
	if s.Status != "skipped" {
		t.Errorf("Expected status 'skipped', got %q", s.Status)
	}
}

func TestHandleGetWorkoutStats(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	db.CompleteSession(session.ID)

	req := httptest.NewRequest("GET", "/api/workout/stats", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetWorkoutStats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var stats map[string]interface{}
	json.NewDecoder(w.Body).Decode(&stats)

	if stats["total_sessions"] != float64(1) {
		t.Errorf("Expected 1 total session, got %v", stats["total_sessions"])
	}
}

func TestHandleListWorkoutSessions(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("GET", "/api/workout/sessions?limit=30", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleListWorkoutSessions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetSessionDetails(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/workout/sessions/details?id=%d", session.ID), nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetSessionDetails(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetRotationState(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "desc", true, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	db.InitializeRotation(group.ID, variant.ID)

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/workout/rotation/state?group_id=%d", group.ID), nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetRotationState(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// --- Security Headers Middleware Test ---

func TestSecurityHeadersMiddleware(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()

	srv.Routes().ServeHTTP(w, req)

	expectedHeaders := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "SAMEORIGIN",
		"Referrer-Policy":              "strict-origin-when-cross-origin",
		"Permissions-Policy":           "camera=(self), microphone=(), geolocation=()",
		"Cross-Origin-Opener-Policy":   "same-origin-allow-popups",
		"Cross-Origin-Resource-Policy": "same-site",
		"Strict-Transport-Security":    "max-age=15552000; includeSubDomains",
			"Content-Security-Policy":      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' https://telegram.org; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; frame-ancestors 'self'",
	}

	for header, expectedVal := range expectedHeaders {
		if val := w.Header().Get(header); val != expectedVal {
			t.Errorf("Expected %s header to be %q, got %q", header, expectedVal, val)
		}
	}
}
