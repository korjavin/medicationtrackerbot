package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func setupFoodTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateAndGetFoodLog(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	now := time.Now().Truncate(time.Second)
	log := &FoodLog{
		UserID:   1,
		EatenAt:  now,
		Weight:   200,
		Carbs:    30,
		Protein:  25,
		Fat:      10,
		Calories: 310,
		Name:     "Chicken breast",
	}

	id, err := s.CreateFoodLog(ctx, log)
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}
	if id == 0 {
		t.Fatal("expected non-zero ID")
	}

	logs, err := s.GetFoodLogs(ctx, 1, now, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}

	got := logs[0]
	if got.ID != id {
		t.Errorf("ID: got %d, want %d", got.ID, id)
	}
	if got.UserID != 1 {
		t.Errorf("UserID: got %d, want 1", got.UserID)
	}
	if got.Name != "Chicken breast" {
		t.Errorf("Name: got %q, want %q", got.Name, "Chicken breast")
	}
	if got.Weight != 200 {
		t.Errorf("Weight: got %d, want 200", got.Weight)
	}
	if got.Carbs != 30 {
		t.Errorf("Carbs: got %d, want 30", got.Carbs)
	}
	if got.Protein != 25 {
		t.Errorf("Protein: got %d, want 25", got.Protein)
	}
	if got.Fat != 10 {
		t.Errorf("Fat: got %d, want 10", got.Fat)
	}
	if got.Calories != 310 {
		t.Errorf("Calories: got %d, want 310", got.Calories)
	}
}

func TestUpdateFoodLog(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	now := time.Now().Truncate(time.Second)
	log := &FoodLog{
		UserID:   1,
		EatenAt:  now,
		Weight:   100,
		Carbs:    10,
		Protein:  20,
		Fat:      5,
		Calories: 165,
		Name:     "Rice",
	}

	id, err := s.CreateFoodLog(ctx, log)
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	log.ID = id
	log.Weight = 150
	log.Carbs = 15
	log.Calories = 248
	log.Name = "Brown rice"

	if err := s.UpdateFoodLog(ctx, log); err != nil {
		t.Fatalf("UpdateFoodLog: %v", err)
	}

	logs, err := s.GetFoodLogs(ctx, 1, now, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Weight != 150 {
		t.Errorf("Weight: got %d, want 150", logs[0].Weight)
	}
	if logs[0].Carbs != 15 {
		t.Errorf("Carbs: got %d, want 15", logs[0].Carbs)
	}
	if logs[0].Calories != 248 {
		t.Errorf("Calories: got %d, want 248", logs[0].Calories)
	}
	if logs[0].Name != "Brown rice" {
		t.Errorf("Name: got %q, want %q", logs[0].Name, "Brown rice")
	}
}

func TestUpdateFoodLogNotFound(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	log := &FoodLog{
		ID:       9999,
		UserID:   1,
		EatenAt:  time.Now(),
		Weight:   100,
		Carbs:    10,
		Protein:  10,
		Fat:      5,
		Calories: 125,
		Name:     "Ghost food",
	}

	err := s.UpdateFoodLog(ctx, log)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestDeleteFoodLog(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	now := time.Now().Truncate(time.Second)
	log := &FoodLog{
		UserID:   1,
		EatenAt:  now,
		Weight:   100,
		Carbs:    10,
		Protein:  10,
		Fat:      5,
		Calories: 125,
		Name:     "Snack",
	}

	id, err := s.CreateFoodLog(ctx, log)
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	// Delete with wrong user should fail
	err = s.DeleteFoodLog(ctx, id, 9999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("delete wrong user: expected sql.ErrNoRows, got %v", err)
	}

	// Delete with correct user should succeed
	if err := s.DeleteFoodLog(ctx, id, 1); err != nil {
		t.Fatalf("DeleteFoodLog: %v", err)
	}

	logs, err := s.GetFoodLogs(ctx, 1, now, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("expected 0 logs after delete, got %d", len(logs))
	}
}

func TestDeleteFoodLogNotFound(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	err := s.DeleteFoodLog(ctx, 9999, 1)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestFoodLogDateRangeFiltering(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 2, 28, 12, 0, 0, 0, time.UTC)

	// Create logs on different days
	for i, name := range []string{"Day0", "Day1", "Day2", "Day3"} {
		eatenAt := base.AddDate(0, 0, -i)
		_, err := s.CreateFoodLog(ctx, &FoodLog{
			UserID:   1,
			EatenAt:  eatenAt,
			Weight:   100,
			Carbs:    10,
			Protein:  10,
			Fat:      5,
			Calories: 125,
			Name:     name,
		})
		if err != nil {
			t.Fatalf("CreateFoodLog(%s): %v", name, err)
		}
	}

	// Query with days=1 should return only today's log
	logs, err := s.GetFoodLogs(ctx, 1, base, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs days=1: %v", err)
	}
	if len(logs) != 1 {
		t.Errorf("days=1: expected 1 log, got %d", len(logs))
	}

	// Query with days=3 should return 3 logs (today, yesterday, day before)
	logs, err = s.GetFoodLogs(ctx, 1, base, 3)
	if err != nil {
		t.Fatalf("GetFoodLogs days=3: %v", err)
	}
	if len(logs) != 3 {
		t.Errorf("days=3: expected 3 logs, got %d", len(logs))
	}

	// Verify ascending order by eaten_at
	for i := 1; i < len(logs); i++ {
		if logs[i].EatenAt.Before(logs[i-1].EatenAt) {
			t.Errorf("logs not in ascending order: [%d]=%v > [%d]=%v",
				i-1, logs[i-1].EatenAt, i, logs[i].EatenAt)
		}
	}

	// Query for different user should return no logs
	logs, err = s.GetFoodLogs(ctx, 9999, base, 7)
	if err != nil {
		t.Fatalf("GetFoodLogs other user: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("other user: expected 0 logs, got %d", len(logs))
	}
}

func TestUpsertFoodProduct(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	p := &FoodProduct{
		UserID:         1,
		Name:           "Oatmeal",
		Carbs100g:      60.0,
		Protein100g:    13.0,
		Fat100g:        7.0,
		EnergyKcal100g: 370.0,
	}

	// First upsert creates the product
	if err := s.UpsertFoodProduct(ctx, p); err != nil {
		t.Fatalf("UpsertFoodProduct (create): %v", err)
	}

	products, _, err := s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}
	if len(products) != 1 {
		t.Fatalf("expected 1 product, got %d", len(products))
	}
	if products[0].Name != "Oatmeal" {
		t.Errorf("Name: got %q, want %q", products[0].Name, "Oatmeal")
	}
	initialUsage := products[0].UsageCount

	// Second upsert with same user_id+name should increment usage_count
	if err := s.UpsertFoodProduct(ctx, p); err != nil {
		t.Fatalf("UpsertFoodProduct (increment): %v", err)
	}

	products, _, err = s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}
	if len(products) != 1 {
		t.Fatalf("expected 1 product after upsert, got %d", len(products))
	}
	if products[0].UsageCount != initialUsage+1 {
		t.Errorf("UsageCount: got %d, want %d", products[0].UsageCount, initialUsage+1)
	}
}

func TestUpdateFoodProduct(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	p := &FoodProduct{
		UserID:         1,
		Name:           "Yogurt",
		Carbs100g:      4.0,
		Protein100g:    10.0,
		Fat100g:        0.5,
		EnergyKcal100g: 60.0,
	}

	if err := s.UpsertFoodProduct(ctx, p); err != nil {
		t.Fatalf("UpsertFoodProduct: %v", err)
	}

	products, _, err := s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}
	if len(products) == 0 {
		t.Fatal("expected at least 1 product")
	}

	toUpdate := products[0]
	toUpdate.Protein100g = 12.0
	toUpdate.EnergyKcal100g = 65.0

	if err := s.UpdateFoodProduct(ctx, &toUpdate); err != nil {
		t.Fatalf("UpdateFoodProduct: %v", err)
	}

	products, _, err = s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts after update: %v", err)
	}
	if products[0].Protein100g != 12.0 {
		t.Errorf("Protein100g: got %f, want 12.0", products[0].Protein100g)
	}
	if products[0].EnergyKcal100g != 65.0 {
		t.Errorf("EnergyKcal100g: got %f, want 65.0", products[0].EnergyKcal100g)
	}
}

func TestUpdateFoodProductWrongUser(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	p := &FoodProduct{
		UserID:         1,
		Name:           "Milk",
		Carbs100g:      5.0,
		Protein100g:    3.4,
		Fat100g:        3.6,
		EnergyKcal100g: 64.0,
	}

	if err := s.UpsertFoodProduct(ctx, p); err != nil {
		t.Fatalf("UpsertFoodProduct: %v", err)
	}

	products, _, err := s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}

	wrongUser := products[0]
	wrongUser.UserID = 9999

	err = s.UpdateFoodProduct(ctx, &wrongUser)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestDeleteFoodProduct(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	p := &FoodProduct{
		UserID:         1,
		Name:           "Bread",
		Carbs100g:      49.0,
		Protein100g:    9.0,
		Fat100g:        3.0,
		EnergyKcal100g: 265.0,
	}

	if err := s.UpsertFoodProduct(ctx, p); err != nil {
		t.Fatalf("UpsertFoodProduct: %v", err)
	}

	products, _, err := s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}
	id := products[0].ID

	// Delete with wrong user
	err = s.DeleteFoodProduct(ctx, id, 9999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("delete wrong user: expected sql.ErrNoRows, got %v", err)
	}

	// Delete with correct user
	if err := s.DeleteFoodProduct(ctx, id, 1); err != nil {
		t.Fatalf("DeleteFoodProduct: %v", err)
	}

	products, _, err = s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts after delete: %v", err)
	}
	if len(products) != 0 {
		t.Errorf("expected 0 products after delete, got %d", len(products))
	}
}

// TestFoodLogNonUTCTimezoneStored reproduces the bug where food added at 23:00
// local time (CET, UTC+1) by the Telegram bot was appearing under the wrong day in
// the web UI.  The bot uses time.Unix which creates time in time.Local; if the
// server runs in a non-UTC zone, the stored timestamp carries a non-UTC offset.
// SQLite does lexicographic text comparison, so "+01:00" timestamps are compared
// incorrectly against the UTC "+00:00" boundaries that GetFoodLogs generates.
// The fix is to store EatenAt always as UTC inside CreateFoodLog / UpdateFoodLog.
func TestFoodLogNonUTCTimezoneStored(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	// Simulate the CET timezone (UTC+1).
	cet := time.FixedZone("CET", 1*60*60)

	// 2026-03-24 23:00 CET  ==  2026-03-24 22:00 UTC.
	// The user is in CET, so this is still "March 24" in their timezone.
	eatTime := time.Date(2026, 3, 24, 23, 0, 0, 0, cet)

	_, err := s.CreateFoodLog(ctx, &FoodLog{
		UserID:   1,
		EatenAt:  eatTime, // stored with +01:00 offset if bug is present
		Weight:   200,
		Carbs:    30,
		Protein:  20,
		Fat:      10,
		Calories: 290,
		Name:     "Late snack",
	})
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	// Query for March 24 in CET — the food MUST appear under this day.
	queryDate := time.Date(2026, 3, 24, 0, 0, 0, 0, cet)
	logs, err := s.GetFoodLogs(ctx, 1, queryDate, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs (March 24 CET): %v", err)
	}
	if len(logs) != 1 {
		t.Errorf("expected 1 log for March 24 CET, got %d (food added at 23:00 CET was placed on wrong day)", len(logs))
	}

	// Query for March 25 in CET — the food must NOT appear here.
	nextDay := time.Date(2026, 3, 25, 0, 0, 0, 0, cet)
	logsNext, err := s.GetFoodLogs(ctx, 1, nextDay, 1)
	if err != nil {
		t.Fatalf("GetFoodLogs (March 25 CET): %v", err)
	}
	if len(logsNext) != 0 {
		t.Errorf("expected 0 logs for March 25 CET, got %d (food added on March 24 at 23:00 CET leaked into March 25)", len(logsNext))
	}
}

func TestDeleteFoodProductNotFound(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	err := s.DeleteFoodProduct(ctx, 9999, 1)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestGetFoodProductsOrderedByUsage(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	// Create products with different usage counts
	products := []struct {
		name    string
		upserts int
	}{
		{"Banana", 1},
		{"Apple", 3},
		{"Orange", 2},
	}

	for _, p := range products {
		for i := 0; i < p.upserts; i++ {
			if err := s.UpsertFoodProduct(ctx, &FoodProduct{
				UserID:         1,
				Name:           p.name,
				Carbs100g:      10.0,
				Protein100g:    1.0,
				Fat100g:        0.5,
				EnergyKcal100g: 50.0,
			}); err != nil {
				t.Fatalf("UpsertFoodProduct(%s, %d): %v", p.name, i, err)
			}
		}
	}

	got, _, err := s.GetFoodProducts(ctx, 1, FoodProductsFilter{Limit: 10})
	if err != nil {
		t.Fatalf("GetFoodProducts: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 products, got %d", len(got))
	}

	// Should be ordered by usage_count DESC
	if got[0].Name != "Apple" {
		t.Errorf("first product: got %q, want %q", got[0].Name, "Apple")
	}
	if got[1].Name != "Orange" {
		t.Errorf("second product: got %q, want %q", got[1].Name, "Orange")
	}
	if got[2].Name != "Banana" {
		t.Errorf("third product: got %q, want %q", got[2].Name, "Banana")
	}
}

func TestSearchFoodProductsByName(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	names := []string{"Chicken breast", "Chicken thigh", "Beef steak"}
	for _, name := range names {
		if err := s.UpsertFoodProduct(ctx, &FoodProduct{
			UserID:         1,
			Name:           name,
			Carbs100g:      0,
			Protein100g:    25.0,
			Fat100g:        5.0,
			EnergyKcal100g: 150.0,
		}); err != nil {
			t.Fatalf("UpsertFoodProduct(%s): %v", name, err)
		}
	}

	results, err := s.SearchFoodProducts(ctx, 1, "chicken")
	if err != nil {
		t.Fatalf("SearchFoodProducts: %v", err)
	}
	if len(results) < 2 {
		t.Errorf("expected at least 2 results for 'chicken', got %d", len(results))
	}

	for _, r := range results {
		if r.Name != "Chicken breast" && r.Name != "Chicken thigh" {
			// Could also match open_food_facts entries, so only check user products
			if r.UserID == 1 {
				t.Errorf("unexpected product in search: %q", r.Name)
			}
		}
	}
}

func TestFoodStatsAggregation(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 2, 28, 12, 0, 0, 0, time.UTC)

	// Create logs on the same day
	meals := []FoodLog{
		{UserID: 1, EatenAt: base.Add(-2 * time.Hour), Weight: 200, Carbs: 30, Protein: 25, Fat: 10, Calories: 310, Name: "Lunch"},
		{UserID: 1, EatenAt: base, Weight: 150, Carbs: 20, Protein: 15, Fat: 8, Calories: 212, Name: "Dinner"},
	}

	// Also add a log from 3 days ago (should be excluded from 1-day query)
	oldMeal := FoodLog{
		UserID: 1, EatenAt: base.AddDate(0, 0, -3),
		Weight: 300, Carbs: 50, Protein: 40, Fat: 20, Calories: 540, Name: "Old meal",
	}

	for _, m := range meals {
		if _, err := s.CreateFoodLog(ctx, &m); err != nil {
			t.Fatalf("CreateFoodLog: %v", err)
		}
	}
	if _, err := s.CreateFoodLog(ctx, &oldMeal); err != nil {
		t.Fatalf("CreateFoodLog (old): %v", err)
	}

	// Stats for 1 day should only include today's meals
	stats, err := s.GetFoodStats(ctx, 1, base, 1)
	if err != nil {
		t.Fatalf("GetFoodStats: %v", err)
	}
	if stats.Calories != 522 {
		t.Errorf("Calories: got %d, want 522", stats.Calories)
	}
	if stats.Carbs != 50 {
		t.Errorf("Carbs: got %d, want 50", stats.Carbs)
	}
	if stats.Protein != 40 {
		t.Errorf("Protein: got %d, want 40", stats.Protein)
	}
	if stats.Fat != 18 {
		t.Errorf("Fat: got %d, want 18", stats.Fat)
	}

	// Stats for 7 days should include all meals
	stats, err = s.GetFoodStats(ctx, 1, base, 7)
	if err != nil {
		t.Fatalf("GetFoodStats 7 days: %v", err)
	}
	if stats.Calories != 1062 {
		t.Errorf("Calories 7 days: got %d, want 1062", stats.Calories)
	}
}

func TestFoodStatsEmpty(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	stats, err := s.GetFoodStats(ctx, 1, time.Now(), 1)
	if err != nil {
		t.Fatalf("GetFoodStats: %v", err)
	}
	if stats.Calories != 0 || stats.Carbs != 0 || stats.Protein != 0 || stats.Fat != 0 {
		t.Errorf("expected all zeros, got %+v", stats)
	}
}

func TestCreateMealFromLogs(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	now := time.Now().Truncate(time.Second)

	log1 := &FoodLog{
		UserID:   1,
		EatenAt:  now,
		Weight:   200,
		Carbs:    30,
		Protein:  25,
		Fat:      10,
		Calories: 310,
		Name:     "Chicken",
	}

	log2 := &FoodLog{
		UserID:   1,
		EatenAt:  now,
		Weight:   100,
		Carbs:    20,
		Protein:  5,
		Fat:      2,
		Calories: 110,
		Name:     "Rice",
	}

	id1, _ := s.CreateFoodLog(ctx, log1)
	id2, _ := s.CreateFoodLog(ctx, log2)

	// Happy path
	product, err := s.CreateMealFromLogs(ctx, 1, "Chicken & Rice Meal", []int64{id1, id2})
	if err != nil {
		t.Fatalf("CreateMealFromLogs: %v", err)
	}

	if product.Name != "Chicken & Rice Meal" {
		t.Errorf("expected meal name 'Chicken & Rice Meal', got %s", product.Name)
	}

	if !product.IsMeal {
		t.Errorf("expected is_meal to be true")
	}

	if product.TotalWeightG != 300 {
		t.Errorf("expected total_weight_g to be 300, got %d", product.TotalWeightG)
	}

	// 100g equivalent verification:
	// Total Weight: 300g
	// Total Carbs: 50 -> Per 100g: 16.666...
	// Total Protein: 30 -> Per 100g: 10
	// Total Fat: 12 -> Per 100g: 4
	// Total Kcal: 420 -> Per 100g: 140

	if product.Protein100g != 10.0 {
		t.Errorf("expected 10g protein per 100g, got %f", product.Protein100g)
	}
	if product.Fat100g != 4.0 {
		t.Errorf("expected 4g fat per 100g, got %f", product.Fat100g)
	}
	if product.EnergyKcal100g != 140.0 {
		t.Errorf("expected 140kcal per 100g, got %f", product.EnergyKcal100g)
	}

	// Empty IDs test
	_, err = s.CreateMealFromLogs(ctx, 1, "Empty Meal", []int64{})
	if err == nil {
		t.Errorf("expected error for empty IDs list")
	}

	// Invalid IDs test
	_, err = s.CreateMealFromLogs(ctx, 1, "Invalid Meal", []int64{999, 1000})
	if err == nil {
		t.Errorf("expected error for invalid IDs")
	}

	// Partial Valid IDs test
	_, err = s.CreateMealFromLogs(ctx, 1, "Partial Meal", []int64{id1, 999})
	if err == nil || err.Error() != "could not find all requested food logs; some may be deleted or belong to another user" {
		t.Errorf("expected partial IDs error, got %v", err)
	}

	// Wrong User test
	_, err = s.CreateMealFromLogs(ctx, 2, "Stolen Meal", []int64{id1, id2})
	if err == nil {
		t.Errorf("expected error for wrong user")
	}
}

func TestFoodTargetsSetAndGet(t *testing.T) {
	s := setupFoodTestStore(t)
	ctx := context.Background()

	// Get default targets
	defaults, err := s.GetFoodTargets(ctx)
	if err != nil {
		t.Fatalf("GetFoodTargets (defaults): %v", err)
	}

	// Set new targets
	targets := FoodTargets{
		Calories: 2200,
		Carbs:    250,
		Protein:  150,
		Fat:      80,
	}
	if err := s.SetFoodTargets(ctx, targets); err != nil {
		t.Fatalf("SetFoodTargets: %v", err)
	}

	got, err := s.GetFoodTargets(ctx)
	if err != nil {
		t.Fatalf("GetFoodTargets: %v", err)
	}
	if got.Calories != 2200 {
		t.Errorf("Calories: got %d, want 2200", got.Calories)
	}
	if got.Carbs != 250 {
		t.Errorf("Carbs: got %d, want 250", got.Carbs)
	}
	if got.Protein != 150 {
		t.Errorf("Protein: got %d, want 150", got.Protein)
	}
	if got.Fat != 80 {
		t.Errorf("Fat: got %d, want 80", got.Fat)
	}

	// Verify values actually changed from defaults (assuming defaults are different)
	_ = defaults

	// Update targets again
	targets.Calories = 1800
	if err := s.SetFoodTargets(ctx, targets); err != nil {
		t.Fatalf("SetFoodTargets (update): %v", err)
	}

	got, err = s.GetFoodTargets(ctx)
	if err != nil {
		t.Fatalf("GetFoodTargets after update: %v", err)
	}
	if got.Calories != 1800 {
		t.Errorf("Calories after update: got %d, want 1800", got.Calories)
	}
}
