package server

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestNew(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer db.Close()

	os.Setenv("EXTERNAL_WORKOUT_API_KEY", "test-api-key")
	defer os.Unsetenv("EXTERNAL_WORKOUT_API_KEY")

	botToken := "test-bot-token"
	sessionSecret := "test-session-secret"
	allowedUserID := int64(123456)
	oidc := OIDCConfig{
		Provider: "google",
		ClientID: "test-client",
	}
	botUsername := "test_bot"
	vapidPublicKey := "test-vapid"

	srv := New(db, botToken, sessionSecret, allowedUserID, oidc, botUsername, vapidPublicKey)
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	if srv == nil {
		t.Fatal("New returned nil")
	}

	if srv.meds != db.Medication {
		t.Error("srv.meds not set correctly")
	}
	if srv.bp != db.BP {
		t.Error("srv.bp not set correctly")
	}
	if srv.weight != db.Weight {
		t.Error("srv.weight not set correctly")
	}
	if srv.workouts != db.Workout {
		t.Error("srv.workouts not set correctly")
	}
	if srv.food != db.Food {
		t.Error("srv.food not set correctly")
	}
	if srv.settings != db.Settings {
		t.Error("srv.settings not set correctly")
	}
	if srv.health != db.Vitals {
		t.Error("srv.health not set correctly")
	}
	if srv.changes != db.Settings {
		t.Error("srv.changes not set correctly")
	}
	if srv.push != db.Push {
		t.Error("srv.push not set correctly")
	}
	if srv.miband != db.Workout {
		t.Error("srv.miband not set correctly")
	}
	if srv.tzPlanStore != db.TZ {
		t.Error("srv.tzPlanStore not set correctly")
	}
	if srv.nonces != db.Auth {
		t.Error("srv.nonces not set correctly")
	}
	if srv.medSvc == nil {
		t.Error("srv.medSvc not set")
	}
	if srv.workoutSvc == nil {
		t.Error("srv.workoutSvc not set")
	}
	if srv.rxnorm == nil {
		t.Error("srv.rxnorm not set")
	}

	if srv.botToken != botToken {
		t.Errorf("Expected botToken %q, got %q", botToken, srv.botToken)
	}
	if srv.sessionSecret != sessionSecret {
		t.Errorf("Expected sessionSecret %q, got %q", sessionSecret, srv.sessionSecret)
	}
	if srv.allowedUserID != allowedUserID {
		t.Errorf("Expected allowedUserID %d, got %d", allowedUserID, srv.allowedUserID)
	}
	if srv.botUsername != botUsername {
		t.Errorf("Expected botUsername %q, got %q", botUsername, srv.botUsername)
	}
	if srv.vapidPublicKey != vapidPublicKey {
		t.Errorf("Expected vapidPublicKey %q, got %q", vapidPublicKey, srv.vapidPublicKey)
	}
	if srv.oidcConfig.ClientID != oidc.ClientID {
		t.Errorf("Expected oidcConfig.ClientID %q, got %q", oidc.ClientID, srv.oidcConfig.ClientID)
	}
	if srv.foodSearchTTL != 30*time.Minute {
		t.Errorf("Expected foodSearchTTL %v, got %v", 30*time.Minute, srv.foodSearchTTL)
	}
	if srv.foodSearchCache == nil {
		t.Error("srv.foodSearchCache not initialized")
	}
	if srv.changeStreamSem == nil {
		t.Error("srv.changeStreamSem not initialized")
	}
	if cap(srv.changeStreamSem) != 40 {
		t.Errorf("Expected changeStreamSem capacity 40, got %d", cap(srv.changeStreamSem))
	}
	if srv.externalAPIKey != "test-api-key" {
		t.Errorf("Expected externalAPIKey 'test-api-key', got %q", srv.externalAPIKey)
	}
}

func TestNew_MissingExternalAPIKey(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer db.Close()

	os.Unsetenv("EXTERNAL_WORKOUT_API_KEY")

	srv := New(db, "test-bot-token", "test-session-secret", 123456, OIDCConfig{}, "test_bot", "test-vapid")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	if srv == nil {
		t.Fatal("New returned nil")
	}

	if srv.externalAPIKey != "" {
		t.Errorf("Expected externalAPIKey to be empty, got %q", srv.externalAPIKey)
	}
}

func TestNew_CustomEnvVars(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	defer db.Close()

	os.Setenv("FOOD_SEARCH_CACHE_MB", "100")
	os.Setenv("CHANGES_STREAM_MAX_CONN", "100")
	defer os.Unsetenv("FOOD_SEARCH_CACHE_MB")
	defer os.Unsetenv("CHANGES_STREAM_MAX_CONN")

	srv := New(db, "test-bot-token", "test-session-secret", 123456, OIDCConfig{}, "test_bot", "test-vapid")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	if srv == nil {
		t.Fatal("New returned nil")
	}

	if cap(srv.changeStreamSem) != 100 {
		t.Errorf("Expected changeStreamSem capacity 100, got %d", cap(srv.changeStreamSem))
	}
}
