package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"
)

func setupDiaryTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateDiaryNote(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	note, err := s.CreateDiaryNote(ctx, 1, "feeling good today", nil)
	if err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}
	if note.ID == 0 {
		t.Error("expected non-zero ID")
	}
	if note.UserID != 1 {
		t.Errorf("expected user_id 1, got %d", note.UserID)
	}
	if note.Content != "feeling good today" {
		t.Errorf("unexpected content: %q", note.Content)
	}
	if note.CreatedAt.IsZero() {
		t.Error("expected non-zero created_at")
	}
	if note.Tag != nil {
		t.Errorf("expected nil tag, got %v", *note.Tag)
	}
}

func TestCreateDiaryNote_WithTag(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	tag := "SLEEP"
	note, err := s.CreateDiaryNote(ctx, 1, "slept 8h", &tag)
	if err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}
	if note.Tag == nil || *note.Tag != "SLEEP" {
		t.Errorf("expected tag SLEEP, got %v", note.Tag)
	}

	notes, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 {
		t.Fatalf("expected 1 note, got %d", len(notes))
	}
	if notes[0].Tag == nil || *notes[0].Tag != "SLEEP" {
		t.Errorf("list: expected tag SLEEP, got %v", notes[0].Tag)
	}
}

func TestUpdateDiaryNoteTag(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	note, err := s.CreateDiaryNote(ctx, 1, "some note", nil)
	if err != nil {
		t.Fatal(err)
	}

	tag := "STRESS"
	if err := s.UpdateDiaryNoteTag(ctx, 1, note.ID, &tag); err != nil {
		t.Fatalf("UpdateDiaryNoteTag: %v", err)
	}

	notes, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if notes[0].Tag == nil || *notes[0].Tag != "STRESS" {
		t.Errorf("expected tag STRESS, got %v", notes[0].Tag)
	}

	// Clearing the tag with nil.
	if err := s.UpdateDiaryNoteTag(ctx, 1, note.ID, nil); err != nil {
		t.Fatalf("UpdateDiaryNoteTag clear: %v", err)
	}
	notes2, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if notes2[0].Tag != nil {
		t.Errorf("expected nil tag after clear, got %v", *notes2[0].Tag)
	}
}

func TestUpdateDiaryNoteTag_WrongUser(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	note, err := s.CreateDiaryNote(ctx, 1, "mine", nil)
	if err != nil {
		t.Fatal(err)
	}

	tag := "NOTE"
	err = s.UpdateDiaryNoteTag(ctx, 2, note.ID, &tag)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows when updating another user's note tag, got %v", err)
	}
}

func TestListDiaryNotes(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	_, err := s.CreateDiaryNote(ctx, 1, "note 1", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateDiaryNote(ctx, 1, "note 2", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateDiaryNote(ctx, 2, "other user note", nil)
	if err != nil {
		t.Fatal(err)
	}

	notes, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatalf("ListDiaryNotes: %v", err)
	}
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	// newest first
	if notes[0].Content != "note 2" {
		t.Errorf("expected newest first, got %q", notes[0].Content)
	}
}

func TestListDiaryNotes_Limit(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if _, err := s.CreateDiaryNote(ctx, 1, "note", nil); err != nil {
			t.Fatal(err)
		}
	}

	notes, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 3, 0)
	if err != nil {
		t.Fatalf("ListDiaryNotes: %v", err)
	}
	if len(notes) != 3 {
		t.Errorf("expected 3 notes with limit, got %d", len(notes))
	}
}

func TestListDiaryNotes_Since(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	// Insert old note with explicit past timestamp to avoid sub-second flakiness.
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO diary_notes (user_id, content, created_at) VALUES (?, ?, ?)`,
		1, "old note", time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		t.Fatal(err)
	}

	cutoff := time.Now()

	_, err = s.CreateDiaryNote(ctx, 1, "new note", nil)
	if err != nil {
		t.Fatal(err)
	}

	notes, err := s.ListDiaryNotes(ctx, 1, cutoff, time.Time{}, 0, 0)
	if err != nil {
		t.Fatalf("ListDiaryNotes with since: %v", err)
	}
	if len(notes) != 1 {
		t.Fatalf("expected 1 note since cutoff, got %d", len(notes))
	}
	if notes[0].Content != "new note" {
		t.Errorf("unexpected content: %q", notes[0].Content)
	}
}

func TestListDiaryNotes_CursorPagination(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if _, err := s.CreateDiaryNote(ctx, 1, fmt.Sprintf("note %d", i), nil); err != nil {
			t.Fatal(err)
		}
	}

	// Page 1: limit 3, no cursor — expect the 3 newest notes.
	page1, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 3, 0)
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1) != 3 {
		t.Fatalf("expected 3 notes on page1, got %d", len(page1))
	}

	// Page 2: cursor is the ID of the last note on page 1.
	cursor := page1[len(page1)-1].ID
	page2, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 3, cursor)
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 2 {
		t.Fatalf("expected 2 notes on page2, got %d", len(page2))
	}

	// Ensure no overlap: all IDs on page 2 must be less than the cursor.
	for _, n := range page2 {
		if n.ID >= cursor {
			t.Errorf("page2 note ID %d is not < cursor %d", n.ID, cursor)
		}
	}
}

func TestDeleteDiaryNote(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	note, err := s.CreateDiaryNote(ctx, 1, "to be deleted", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteDiaryNote(ctx, 1, note.ID); err != nil {
		t.Fatalf("DeleteDiaryNote: %v", err)
	}

	notes, err := s.ListDiaryNotes(ctx, 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 0 {
		t.Errorf("expected 0 notes after delete, got %d", len(notes))
	}
}

func TestDeleteDiaryNote_WrongUser(t *testing.T) {
	s := setupDiaryTestStore(t)
	ctx := context.Background()

	note, err := s.CreateDiaryNote(ctx, 1, "my note", nil)
	if err != nil {
		t.Fatal(err)
	}

	// user 2 tries to delete user 1's note — should error with sql.ErrNoRows
	err = s.DeleteDiaryNote(ctx, 2, note.ID)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected sql.ErrNoRows when deleting another user's note, got %v", err)
	}
}
