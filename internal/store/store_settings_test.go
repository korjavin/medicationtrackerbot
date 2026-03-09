package store

import (
	"context"
	"testing"
	"time"
)

func setupSettingsTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestFeatureFlags(t *testing.T) {
	db := setupSettingsTestStore(t)
	ctx := context.Background()

	tests := []struct {
		name       string
		getter     func(context.Context) (bool, error)
		setter     func(context.Context, bool) error
		defaultVal bool
	}{
		{"FoodIntake", db.GetFoodIntakeEnabled, db.SetFoodIntakeEnabled, false},
		{"BloodPressure", db.GetBloodPressureEnabled, db.SetBloodPressureEnabled, true},
		{"Weight", db.GetWeightEnabled, db.SetWeightEnabled, true},
		{"Medication", db.GetMedicationEnabled, db.SetMedicationEnabled, true},
		{"Workout", db.GetWorkoutEnabled, db.SetWorkoutEnabled, true},
		{"Health", db.GetHealthEnabled, db.SetHealthEnabled, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Default value
			val, err := tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected default %v for %s, got %v", tt.defaultVal, tt.name, val)
			}

			// Toggle to opposite
			if err := tt.setter(ctx, !tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, !tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle: %v", tt.name, err)
			}
			if val != !tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle", !tt.defaultVal, tt.name)
			}

			// Toggle back
			if err := tt.setter(ctx, tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle back: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle back", tt.defaultVal, tt.name)
			}
		})
	}
}

func TestPushSubscriptions(t *testing.T) {
	db := setupSettingsTestStore(t)
	userID := int64(123456)

	// Initially empty
	subs, err := db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("Expected 0 subscriptions, got %d", len(subs))
	}

	// Create subscription
	err = db.CreatePushSubscription(userID, "https://push.example.com/1", "auth-key-1", "p256dh-key-1")
	if err != nil {
		t.Fatalf("CreatePushSubscription: %v", err)
	}

	subs, err = db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions after create: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("Expected 1 subscription, got %d", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/1" {
		t.Errorf("Expected endpoint 'https://push.example.com/1', got %q", subs[0].Endpoint)
	}
	if subs[0].Auth != "auth-key-1" {
		t.Errorf("Expected auth 'auth-key-1', got %q", subs[0].Auth)
	}
	if !subs[0].Enabled {
		t.Error("Expected subscription to be enabled")
	}

	// Create second subscription
	err = db.CreatePushSubscription(userID, "https://push.example.com/2", "auth-key-2", "p256dh-key-2")
	if err != nil {
		t.Fatalf("CreatePushSubscription 2: %v", err)
	}

	subs, err = db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions: %v", err)
	}
	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions, got %d", len(subs))
	}

	// Upsert existing endpoint updates keys
	err = db.CreatePushSubscription(userID, "https://push.example.com/1", "auth-key-1-updated", "p256dh-key-1-updated")
	if err != nil {
		t.Fatalf("Upsert PushSubscription: %v", err)
	}

	subs, err = db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions after upsert: %v", err)
	}
	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions after upsert, got %d", len(subs))
	}

	// Disable subscription
	err = db.DisablePushSubscription("https://push.example.com/1")
	if err != nil {
		t.Fatalf("DisablePushSubscription: %v", err)
	}

	// GetPushSubscriptions only returns enabled
	subs, err = db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions after disable: %v", err)
	}
	if len(subs) != 1 {
		t.Errorf("Expected 1 enabled subscription, got %d", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/2" {
		t.Errorf("Expected remaining endpoint to be /2, got %q", subs[0].Endpoint)
	}

	// Delete subscription
	err = db.DeletePushSubscription("https://push.example.com/2")
	if err != nil {
		t.Fatalf("DeletePushSubscription: %v", err)
	}

	subs, err = db.GetPushSubscriptions(userID)
	if err != nil {
		t.Fatalf("GetPushSubscriptions after delete: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("Expected 0 subscriptions after delete, got %d", len(subs))
	}
}

func TestLastDownload(t *testing.T) {
	db := setupSettingsTestStore(t)

	// Set a download time
	now := time.Now().Truncate(time.Second)
	err := db.UpdateLastDownload(now)
	if err != nil {
		t.Fatalf("UpdateLastDownload: %v", err)
	}

	// Retrieve it
	last, err := db.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after update: %v", err)
	}
	diff := last.Sub(now)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", now, last, diff)
	}

	// Update again
	later := now.Add(time.Hour)
	err = db.UpdateLastDownload(later)
	if err != nil {
		t.Fatalf("UpdateLastDownload again: %v", err)
	}

	last, err = db.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after second update: %v", err)
	}
	diff = last.Sub(later)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", later, last, diff)
	}
}

func TestPushSubscriptionDifferentUsers(t *testing.T) {
	db := setupSettingsTestStore(t)
	user1 := int64(111)
	user2 := int64(222)

	err := db.CreatePushSubscription(user1, "https://push.example.com/u1", "auth1", "p256dh1")
	if err != nil {
		t.Fatalf("CreatePushSubscription user1: %v", err)
	}
	err = db.CreatePushSubscription(user2, "https://push.example.com/u2", "auth2", "p256dh2")
	if err != nil {
		t.Fatalf("CreatePushSubscription user2: %v", err)
	}

	subs1, err := db.GetPushSubscriptions(user1)
	if err != nil {
		t.Fatalf("GetPushSubscriptions user1: %v", err)
	}
	if len(subs1) != 1 {
		t.Errorf("Expected 1 subscription for user1, got %d", len(subs1))
	}

	subs2, err := db.GetPushSubscriptions(user2)
	if err != nil {
		t.Fatalf("GetPushSubscriptions user2: %v", err)
	}
	if len(subs2) != 1 {
		t.Errorf("Expected 1 subscription for user2, got %d", len(subs2))
	}
}

func TestStore_TabOrder(t *testing.T) {
	s := setupSettingsTestStore(t)
	defer s.Close()
	ctx := context.Background()

	// Initial value should be empty
	order, err := s.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != "" {
		t.Fatalf("expected empty string, got %s", order)
	}

	// Update the order
	err = s.SetTabOrder(ctx, `["tab1", "tab2"]`)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Verify the update
	order, err = s.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != `["tab1", "tab2"]` {
		t.Fatalf("expected '[\"tab1\", \"tab2\"]', got %s", order)
	}
}
