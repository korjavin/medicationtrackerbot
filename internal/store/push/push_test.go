package push

import (
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

func setupPushRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func TestPushSubscriptions(t *testing.T) {
	r := setupPushRepo(t)
	userID := int64(123456)

	// Initially empty
	subs, err := r.List(userID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("Expected 0 subscriptions, got %d", len(subs))
	}

	// Create subscription
	if err := r.Create(userID, "https://push.example.com/1", "auth-key-1", "p256dh-key-1"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List after create: %v", err)
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
	if err := r.Create(userID, "https://push.example.com/2", "auth-key-2", "p256dh-key-2"); err != nil {
		t.Fatalf("Create 2: %v", err)
	}

	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions, got %d", len(subs))
	}

	// Upsert existing endpoint updates keys
	if err := r.Create(userID, "https://push.example.com/1", "auth-key-1-updated", "p256dh-key-1-updated"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List after upsert: %v", err)
	}
	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions after upsert, got %d", len(subs))
	}

	// Disable subscription
	if err := r.Disable("https://push.example.com/1"); err != nil {
		t.Fatalf("Disable: %v", err)
	}

	// List only returns enabled
	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List after disable: %v", err)
	}
	if len(subs) != 1 {
		t.Errorf("Expected 1 enabled subscription, got %d", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/2" {
		t.Errorf("Expected remaining endpoint to be /2, got %q", subs[0].Endpoint)
	}

	// Re-create on disabled endpoint re-enables it (upsert path resets enabled=1).
	if err := r.Create(userID, "https://push.example.com/1", "auth-key-1-resub", "p256dh-key-1-resub"); err != nil {
		t.Fatalf("Re-create disabled: %v", err)
	}
	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List after re-create: %v", err)
	}
	if len(subs) != 2 {
		t.Errorf("Expected 2 enabled after re-subscribe, got %d", len(subs))
	}

	// Delete subscription
	if err := r.Delete("https://push.example.com/2"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	subs, err = r.List(userID)
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(subs) != 1 {
		t.Errorf("Expected 1 subscription after delete, got %d", len(subs))
	}
}

func TestPushSubscriptionDifferentUsers(t *testing.T) {
	r := setupPushRepo(t)
	user1 := int64(111)
	user2 := int64(222)

	if err := r.Create(user1, "https://push.example.com/u1", "auth1", "p256dh1"); err != nil {
		t.Fatalf("Create user1: %v", err)
	}
	if err := r.Create(user2, "https://push.example.com/u2", "auth2", "p256dh2"); err != nil {
		t.Fatalf("Create user2: %v", err)
	}

	subs1, err := r.List(user1)
	if err != nil {
		t.Fatalf("List user1: %v", err)
	}
	if len(subs1) != 1 {
		t.Errorf("Expected 1 subscription for user1, got %d", len(subs1))
	}

	subs2, err := r.List(user2)
	if err != nil {
		t.Fatalf("List user2: %v", err)
	}
	if len(subs2) != 1 {
		t.Errorf("Expected 1 subscription for user2, got %d", len(subs2))
	}
}
