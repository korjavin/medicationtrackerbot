package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestFetchContextNotesReturnsNotesInRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	if _, err := st.CreateDiaryNote(ctx, userID, "started new medication"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}
	if _, err := st.CreateDiaryNote(ctx, userID, "high stress at work"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	now := time.Now()
	notes, truncated, warnMsg := s.fetchContextNotes(ctx, now.AddDate(0, 0, -7), now.AddDate(0, 0, 1))

	if truncated {
		t.Error("expected truncated=false for 2 notes")
	}
	if warnMsg != "" {
		t.Errorf("expected no warning, got %q", warnMsg)
	}
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	// Notes are returned newest first
	if notes[0].Content != "high stress at work" {
		t.Errorf("expected newest note first, got %q", notes[0].Content)
	}
	if notes[0].CreatedAt == "" {
		t.Error("expected non-empty CreatedAt")
	}
}

func TestFetchContextNotesReturnsNilWhenEmpty(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	start, _ := time.Parse("2006-01-02", "2020-01-01")
	end, _ := time.Parse("2006-01-02", "2020-01-31")

	notes, truncated, warnMsg := s.fetchContextNotes(ctx, start, end)
	if notes != nil {
		t.Fatalf("expected nil for empty notes, got %v", notes)
	}
	if truncated {
		t.Error("expected truncated=false for empty notes")
	}
	if warnMsg != "" {
		t.Errorf("expected no warning, got %q", warnMsg)
	}
}

func TestFetchContextNotesExcludesOutOfRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	if _, err := st.CreateDiaryNote(ctx, userID, "within range"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	// Query a range far in the past that won't include the note we just created
	start, _ := time.Parse("2006-01-02", "2020-01-01")
	end, _ := time.Parse("2006-01-02", "2020-01-31")

	notes, _, _ := s.fetchContextNotes(ctx, start, end)
	if notes != nil {
		t.Fatalf("expected nil for out-of-range notes, got %d notes", len(notes))
	}
}

func TestFetchContextNotesOtherUserExcluded(t *testing.T) {
	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}
	defer st.Close()

	ctx := context.Background()
	// Create note for a different user
	if _, err := st.CreateDiaryNote(ctx, 999999, "other user note"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       123456,
		},
		data: st,
	}

	now := time.Now()
	notes, _, _ := s.fetchContextNotes(ctx, now.AddDate(0, 0, -7), now.AddDate(0, 0, 1))
	if notes != nil {
		t.Fatalf("expected nil, got %d notes from other user", len(notes))
	}
}

func TestShouldIncludeNotes(t *testing.T) {
	tests := []struct {
		name         string
		excludeNotes bool
		want         bool
	}{
		{"default includes notes", false, true},
		{"exclude_notes=true suppresses notes", true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldIncludeNotes(tt.excludeNotes)
			if got != tt.want {
				t.Errorf("shouldIncludeNotes(%v) = %v, want %v", tt.excludeNotes, got, tt.want)
			}
		})
	}
}
