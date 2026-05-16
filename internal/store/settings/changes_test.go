package settings

import (
	"context"
	"testing"
)

func TestGetLatestChangeCursorEmpty(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	cursor, err := r.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}
	if cursor != 0 {
		t.Errorf("Expected cursor 0 for empty table, got %d", cursor)
	}
}

func TestListChangedTagsSinceEmpty(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	cursor, tags, err := r.ListChangedTagsSince(ctx, 0)
	if err != nil {
		t.Fatalf("ListChangedTagsSince: %v", err)
	}
	if cursor != 0 {
		t.Errorf("Expected cursor 0, got %d", cursor)
	}
	if len(tags) != 0 {
		t.Errorf("Expected 0 tags, got %d", len(tags))
	}
}

func TestChangeEventsWithData(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Insert change events directly (normally done by triggers)
	_, err := r.db.ExecContext(ctx, "INSERT INTO change_events (tag) VALUES (?)", "bp")
	if err != nil {
		t.Fatalf("Insert change event: %v", err)
	}
	_, err = r.db.ExecContext(ctx, "INSERT INTO change_events (tag) VALUES (?)", "weight")
	if err != nil {
		t.Fatalf("Insert change event: %v", err)
	}
	_, err = r.db.ExecContext(ctx, "INSERT INTO change_events (tag) VALUES (?)", "bp")
	if err != nil {
		t.Fatalf("Insert change event: %v", err)
	}

	// Latest cursor should be 3
	cursor, err := r.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}
	if cursor != 3 {
		t.Errorf("Expected cursor 3, got %d", cursor)
	}

	// Get all tags since 0
	cursor, tags, err := r.ListChangedTagsSince(ctx, 0)
	if err != nil {
		t.Fatalf("ListChangedTagsSince(0): %v", err)
	}
	if cursor != 3 {
		t.Errorf("Expected cursor 3, got %d", cursor)
	}
	if len(tags) != 2 {
		t.Fatalf("Expected 2 distinct tags, got %d: %v", len(tags), tags)
	}
	// Tags are ordered ASC
	if tags[0] != "bp" || tags[1] != "weight" {
		t.Errorf("Expected [bp, weight], got %v", tags)
	}

	// Get tags since cursor 1 (should still include both)
	_, tags, err = r.ListChangedTagsSince(ctx, 1)
	if err != nil {
		t.Fatalf("ListChangedTagsSince(1): %v", err)
	}
	if len(tags) != 2 {
		t.Errorf("Expected 2 tags since cursor 1, got %d", len(tags))
	}

	// Get tags since cursor 2 (only bp at id=3)
	_, tags, err = r.ListChangedTagsSince(ctx, 2)
	if err != nil {
		t.Fatalf("ListChangedTagsSince(2): %v", err)
	}
	if len(tags) != 1 {
		t.Fatalf("Expected 1 tag since cursor 2, got %d", len(tags))
	}
	if tags[0] != "bp" {
		t.Errorf("Expected tag 'bp', got %q", tags[0])
	}

	// Get tags since cursor 3 (nothing new)
	_, tags, err = r.ListChangedTagsSince(ctx, 3)
	if err != nil {
		t.Fatalf("ListChangedTagsSince(3): %v", err)
	}
	if len(tags) != 0 {
		t.Errorf("Expected 0 tags since cursor 3, got %d", len(tags))
	}
}

func TestPruneChangeEvents(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Insert 10 events
	for i := 0; i < 10; i++ {
		_, err := r.db.ExecContext(ctx, "INSERT INTO change_events (tag) VALUES (?)", "test")
		if err != nil {
			t.Fatalf("Insert event %d: %v", i, err)
		}
	}

	cursor, err := r.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}
	if cursor != 10 {
		t.Errorf("Expected cursor 10, got %d", cursor)
	}

	// Prune keeping last 5
	err = r.PruneChangeEvents(ctx, 5, 0)
	if err != nil {
		t.Fatalf("PruneChangeEvents: %v", err)
	}

	// Count remaining
	var count int
	err = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM change_events").Scan(&count)
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 5 {
		t.Errorf("Expected 5 remaining after prune, got %d", count)
	}

	// Cursor should still be 10 (max id)
	cursor, err = r.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor after prune: %v", err)
	}
	if cursor != 10 {
		t.Errorf("Expected cursor 10 after prune, got %d", cursor)
	}
}

func TestPruneChangeEventsByAge(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Insert old events
	_, err := r.db.ExecContext(ctx, "INSERT INTO change_events (tag, created_at) VALUES (?, datetime('now', '-10 days'))", "old")
	if err != nil {
		t.Fatalf("Insert old event: %v", err)
	}
	_, err = r.db.ExecContext(ctx, "INSERT INTO change_events (tag) VALUES (?)", "new")
	if err != nil {
		t.Fatalf("Insert new event: %v", err)
	}

	// Prune events older than 5 days
	err = r.PruneChangeEvents(ctx, 0, 5)
	if err != nil {
		t.Fatalf("PruneChangeEvents by age: %v", err)
	}

	var count int
	err = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM change_events").Scan(&count)
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 1 {
		t.Errorf("Expected 1 remaining after age prune, got %d", count)
	}
}
