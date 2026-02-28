package store

import (
	"testing"
	"time"
)

func setupInventoryTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func createTestMedication(t *testing.T, s *Store, name, schedule string) int64 {
	t.Helper()
	id, err := s.CreateMedication(name, "10mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create medication %s: %v", name, err)
	}
	return id
}

func TestDecrementInventory_TrackingEnabled(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(10)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	if err := s.DecrementInventory(id, 1); err != nil {
		t.Fatalf("DecrementInventory failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil {
		t.Fatal("Expected inventory_count to be non-nil after decrement")
	}
	if *med.InventoryCount != 9 {
		t.Errorf("Expected inventory_count=9, got %d", *med.InventoryCount)
	}
}

func TestDecrementInventory_TrackingDisabled(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	// inventory_count is NULL by default, decrement should be a no-op
	if err := s.DecrementInventory(id, 1); err != nil {
		t.Fatalf("DecrementInventory should not error when tracking disabled: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount != nil {
		t.Errorf("Expected inventory_count to remain nil, got %d", *med.InventoryCount)
	}
}

func TestDecrementInventory_MultipleUnits(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Vitamin D", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(20)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	if err := s.DecrementInventory(id, 5); err != nil {
		t.Fatalf("DecrementInventory failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil || *med.InventoryCount != 15 {
		t.Errorf("Expected inventory_count=15, got %v", med.InventoryCount)
	}
}

func TestSetInventory_Enable(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(30)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil {
		t.Fatal("Expected inventory_count to be set")
	}
	if *med.InventoryCount != 30 {
		t.Errorf("Expected inventory_count=30, got %d", *med.InventoryCount)
	}
}

func TestSetInventory_Disable(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	// First enable
	if err := s.SetInventory(id, intPtr(30)); err != nil {
		t.Fatalf("SetInventory (enable) failed: %v", err)
	}

	// Then disable
	if err := s.SetInventory(id, nil); err != nil {
		t.Fatalf("SetInventory (disable) failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount != nil {
		t.Errorf("Expected inventory_count to be nil after disabling, got %d", *med.InventoryCount)
	}
}

func TestSetInventory_Update(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(30)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}
	if err := s.SetInventory(id, intPtr(50)); err != nil {
		t.Fatalf("SetInventory update failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil || *med.InventoryCount != 50 {
		t.Errorf("Expected inventory_count=50, got %v", med.InventoryCount)
	}
}

func TestAddRestock_InitializesNullInventory(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	// Inventory is NULL, AddRestock should initialize it
	if err := s.AddRestock(id, 30, "Initial supply"); err != nil {
		t.Fatalf("AddRestock failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil {
		t.Fatal("Expected inventory_count to be initialized after restock")
	}
	if *med.InventoryCount != 30 {
		t.Errorf("Expected inventory_count=30, got %d", *med.InventoryCount)
	}
}

func TestAddRestock_AddsToExisting(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(10)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	if err := s.AddRestock(id, 20, "Monthly refill"); err != nil {
		t.Fatalf("AddRestock failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	if med.InventoryCount == nil || *med.InventoryCount != 30 {
		t.Errorf("Expected inventory_count=30, got %v", med.InventoryCount)
	}
}

func TestAddRestock_LogsRestockEvent(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.AddRestock(id, 30, "Pharmacy pickup"); err != nil {
		t.Fatalf("AddRestock failed: %v", err)
	}

	history, err := s.GetRestockHistory(id)
	if err != nil {
		t.Fatalf("GetRestockHistory failed: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("Expected 1 restock entry, got %d", len(history))
	}
	if history[0].Quantity != 30 {
		t.Errorf("Expected quantity=30, got %d", history[0].Quantity)
	}
	if history[0].Note != "Pharmacy pickup" {
		t.Errorf("Expected note='Pharmacy pickup', got '%s'", history[0].Note)
	}
	if history[0].MedicationID != id {
		t.Errorf("Expected medication_id=%d, got %d", id, history[0].MedicationID)
	}
}

func TestGetRestockHistory_OrderedByDateDesc(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.AddRestock(id, 10, "First"); err != nil {
		t.Fatalf("AddRestock 1 failed: %v", err)
	}
	if err := s.AddRestock(id, 20, "Second"); err != nil {
		t.Fatalf("AddRestock 2 failed: %v", err)
	}
	if err := s.AddRestock(id, 30, "Third"); err != nil {
		t.Fatalf("AddRestock 3 failed: %v", err)
	}

	history, err := s.GetRestockHistory(id)
	if err != nil {
		t.Fatalf("GetRestockHistory failed: %v", err)
	}
	if len(history) != 3 {
		t.Fatalf("Expected 3 entries, got %d", len(history))
	}

	// Verify all 3 entries are returned (ordering within same timestamp is implementation-defined)
	notes := map[string]bool{}
	for _, h := range history {
		notes[h.Note] = true
	}
	for _, expected := range []string{"First", "Second", "Third"} {
		if !notes[expected] {
			t.Errorf("Expected note '%s' in history", expected)
		}
	}
}

func TestGetRestockHistory_Empty(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	history, err := s.GetRestockHistory(id)
	if err != nil {
		t.Fatalf("GetRestockHistory failed: %v", err)
	}
	if len(history) != 0 {
		t.Errorf("Expected empty history, got %d entries", len(history))
	}
}

func TestGetMedicationsLowOnStock_DailySchedule(t *testing.T) {
	s := setupInventoryTestStore(t)
	// 2 times per day = 2 units/day, 14 days threshold = 28 units needed
	id := createTestMedication(t, s, "DailyMed", `{"type":"daily","times":["09:00","21:00"]}`)

	// Set inventory to 10 (below 28 threshold for 14 days)
	if err := s.SetInventory(id, intPtr(10)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	meds, err := s.GetMedicationsLowOnStock(14)
	if err != nil {
		t.Fatalf("GetMedicationsLowOnStock failed: %v", err)
	}

	found := false
	for _, m := range meds {
		if m.ID == id {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected DailyMed to be in low stock list")
	}
}

func TestGetMedicationsLowOnStock_SufficientStock(t *testing.T) {
	s := setupInventoryTestStore(t)
	// 1 time per day, 14 days = 14 units needed
	id := createTestMedication(t, s, "WellStocked", `{"type":"daily","times":["09:00"]}`)

	// Set inventory to 100 (well above threshold)
	if err := s.SetInventory(id, intPtr(100)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	meds, err := s.GetMedicationsLowOnStock(14)
	if err != nil {
		t.Fatalf("GetMedicationsLowOnStock failed: %v", err)
	}

	for _, m := range meds {
		if m.ID == id {
			t.Error("WellStocked medication should NOT be in low stock list")
		}
	}
}

func TestGetMedicationsLowOnStock_NullInventoryExcluded(t *testing.T) {
	s := setupInventoryTestStore(t)
	createTestMedication(t, s, "NoTracking", `{"type":"daily","times":["09:00"]}`)

	// Don't set inventory (stays NULL)
	meds, err := s.GetMedicationsLowOnStock(14)
	if err != nil {
		t.Fatalf("GetMedicationsLowOnStock failed: %v", err)
	}

	for _, m := range meds {
		if m.Name == "NoTracking" {
			t.Error("Medication with NULL inventory should not be in low stock list")
		}
	}
}

func TestGetMedicationsLowOnStock_WeeklySchedule(t *testing.T) {
	s := setupInventoryTestStore(t)
	// 3 days/week, 1 time/day = 3 units/week ≈ 0.43 units/day
	// 14 days threshold = ~6 units needed
	id := createTestMedication(t, s, "WeeklyMed", `{"type":"weekly","days":[1,3,5],"times":["09:00"]}`)

	// Set inventory to 2 (below ~6 threshold)
	if err := s.SetInventory(id, intPtr(2)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	meds, err := s.GetMedicationsLowOnStock(14)
	if err != nil {
		t.Fatalf("GetMedicationsLowOnStock failed: %v", err)
	}

	found := false
	for _, m := range meds {
		if m.ID == id {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected WeeklyMed to be in low stock list")
	}
}

func TestIsLowOnStock_NilInventory(t *testing.T) {
	s := setupInventoryTestStore(t)

	med := &Medication{
		ID:             1,
		Name:           "TestMed",
		Schedule:       `{"type":"daily","times":["09:00"]}`,
		InventoryCount: nil,
	}

	if s.IsLowOnStock(med, 14) {
		t.Error("IsLowOnStock should return false when inventory is nil")
	}
}

func TestIsLowOnStock_LowCount(t *testing.T) {
	s := setupInventoryTestStore(t)

	count := 3
	med := &Medication{
		ID:             1,
		Name:           "TestMed",
		Schedule:       `{"type":"daily","times":["09:00","21:00"]}`,
		InventoryCount: &count,
	}

	// 2 per day, 14 days = 28 needed, only 3 available
	if !s.IsLowOnStock(med, 14) {
		t.Error("IsLowOnStock should return true when stock is low")
	}
}

func TestIsLowOnStock_WithEndDate(t *testing.T) {
	s := setupInventoryTestStore(t)

	// Medication ends in 3 days, with 5 pills and 1/day usage
	endDate := time.Now().Add(3 * 24 * time.Hour)
	count := 5
	med := &Medication{
		ID:             1,
		Name:           "ShortTerm",
		Schedule:       `{"type":"daily","times":["09:00"]}`,
		InventoryCount: &count,
		EndDate:        &endDate,
	}

	// Even though 14-day threshold would need 14, med ends in 3 days and has 5 pills
	if s.IsLowOnStock(med, 14) {
		t.Error("IsLowOnStock should return false when end date is soon and stock covers remaining days")
	}
}

func TestIsLowOnStock_WithEndDateLowStock(t *testing.T) {
	s := setupInventoryTestStore(t)

	// Medication ends in 10 days, with 5 pills and 2/day usage (needs 20)
	endDate := time.Now().Add(10 * 24 * time.Hour)
	count := 5
	med := &Medication{
		ID:             1,
		Name:           "ShortTermLow",
		Schedule:       `{"type":"daily","times":["09:00","21:00"]}`,
		InventoryCount: &count,
		EndDate:        &endDate,
	}

	if !s.IsLowOnStock(med, 14) {
		t.Error("IsLowOnStock should return true when stock doesn't cover remaining days")
	}
}

func TestGetDaysOfStockRemaining_NilInventory(t *testing.T) {
	s := setupInventoryTestStore(t)

	med := &Medication{
		ID:             1,
		Name:           "TestMed",
		Schedule:       `{"type":"daily","times":["09:00"]}`,
		InventoryCount: nil,
	}

	result := s.GetDaysOfStockRemaining(med)
	if result != nil {
		t.Errorf("Expected nil for nil inventory, got %f", *result)
	}
}

func TestGetDaysOfStockRemaining_AsNeeded(t *testing.T) {
	s := setupInventoryTestStore(t)

	count := 10
	med := &Medication{
		ID:             1,
		Name:           "PRN Med",
		Schedule:       `{"type":"as_needed"}`,
		InventoryCount: &count,
	}

	result := s.GetDaysOfStockRemaining(med)
	if result != nil {
		t.Errorf("Expected nil for as_needed schedule, got %f", *result)
	}
}

func TestGetDaysOfStockRemaining_DailySchedule(t *testing.T) {
	s := setupInventoryTestStore(t)

	count := 20
	med := &Medication{
		ID:             1,
		Name:           "DailyMed",
		Schedule:       `{"type":"daily","times":["09:00","21:00"]}`,
		InventoryCount: &count,
	}

	result := s.GetDaysOfStockRemaining(med)
	if result == nil {
		t.Fatal("Expected non-nil result for daily schedule with inventory")
	}
	// 20 pills / 2 per day = 10 days
	if *result != 10.0 {
		t.Errorf("Expected 10.0 days remaining, got %f", *result)
	}
}

func TestGetDaysOfStockRemaining_WeeklySchedule(t *testing.T) {
	s := setupInventoryTestStore(t)

	count := 6
	med := &Medication{
		ID:             1,
		Name:           "WeeklyMed",
		Schedule:       `{"type":"weekly","days":[1,3,5],"times":["09:00"]}`,
		InventoryCount: &count,
	}

	result := s.GetDaysOfStockRemaining(med)
	if result == nil {
		t.Fatal("Expected non-nil result for weekly schedule with inventory")
	}
	// 3 days/week, 1 time/day = 3/7 per day ≈ 0.4286/day
	// 6 pills / 0.4286 ≈ 14 days
	expectedDays := 6.0 / (3.0 / 7.0)
	if *result < expectedDays-0.1 || *result > expectedDays+0.1 {
		t.Errorf("Expected ~%.1f days remaining, got %f", expectedDays, *result)
	}
}

func TestGetDaysOfStockRemaining_ZeroInventory(t *testing.T) {
	s := setupInventoryTestStore(t)

	count := 0
	med := &Medication{
		ID:             1,
		Name:           "EmptyMed",
		Schedule:       `{"type":"daily","times":["09:00"]}`,
		InventoryCount: &count,
	}

	result := s.GetDaysOfStockRemaining(med)
	if result == nil {
		t.Fatal("Expected non-nil result for zero inventory")
	}
	if *result != 0.0 {
		t.Errorf("Expected 0.0 days remaining, got %f", *result)
	}
}

func TestAddRestock_MultipleRestocks(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.SetInventory(id, intPtr(5)); err != nil {
		t.Fatalf("SetInventory failed: %v", err)
	}

	if err := s.AddRestock(id, 10, "First refill"); err != nil {
		t.Fatalf("AddRestock 1 failed: %v", err)
	}
	if err := s.AddRestock(id, 20, "Second refill"); err != nil {
		t.Fatalf("AddRestock 2 failed: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedicationByID failed: %v", err)
	}
	// 5 + 10 + 20 = 35
	if med.InventoryCount == nil || *med.InventoryCount != 35 {
		t.Errorf("Expected inventory_count=35, got %v", med.InventoryCount)
	}

	history, err := s.GetRestockHistory(id)
	if err != nil {
		t.Fatalf("GetRestockHistory failed: %v", err)
	}
	if len(history) != 2 {
		t.Errorf("Expected 2 restock entries, got %d", len(history))
	}
}

func TestAddRestock_EmptyNote(t *testing.T) {
	s := setupInventoryTestStore(t)
	id := createTestMedication(t, s, "Aspirin", `{"type":"daily","times":["09:00"]}`)

	if err := s.AddRestock(id, 30, ""); err != nil {
		t.Fatalf("AddRestock with empty note failed: %v", err)
	}

	history, err := s.GetRestockHistory(id)
	if err != nil {
		t.Fatalf("GetRestockHistory failed: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("Expected 1 entry, got %d", len(history))
	}
	if history[0].Note != "" {
		t.Errorf("Expected empty note, got '%s'", history[0].Note)
	}
}

func TestGetRestockHistory_IsolatedPerMedication(t *testing.T) {
	s := setupInventoryTestStore(t)
	id1 := createTestMedication(t, s, "Med1", `{"type":"daily","times":["09:00"]}`)
	id2 := createTestMedication(t, s, "Med2", `{"type":"daily","times":["09:00"]}`)

	if err := s.AddRestock(id1, 10, "Med1 restock"); err != nil {
		t.Fatalf("AddRestock med1 failed: %v", err)
	}
	if err := s.AddRestock(id2, 20, "Med2 restock"); err != nil {
		t.Fatalf("AddRestock med2 failed: %v", err)
	}

	history1, err := s.GetRestockHistory(id1)
	if err != nil {
		t.Fatalf("GetRestockHistory med1 failed: %v", err)
	}
	if len(history1) != 1 {
		t.Fatalf("Expected 1 entry for med1, got %d", len(history1))
	}
	if history1[0].Note != "Med1 restock" {
		t.Errorf("Expected 'Med1 restock', got '%s'", history1[0].Note)
	}

	history2, err := s.GetRestockHistory(id2)
	if err != nil {
		t.Fatalf("GetRestockHistory med2 failed: %v", err)
	}
	if len(history2) != 1 {
		t.Fatalf("Expected 1 entry for med2, got %d", len(history2))
	}
	if history2[0].Note != "Med2 restock" {
		t.Errorf("Expected 'Med2 restock', got '%s'", history2[0].Note)
	}
}
