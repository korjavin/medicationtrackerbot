package domain

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type fakeNotesStore struct {
	notes       []store.DiaryNote
	nextID      int64
	createErr   error
	deleteErr   error
	listErr     error
	lastTagSent *string
}

func (f *fakeNotesStore) CreateDiaryNote(ctx context.Context, userID int64, content string, tag *string) (*store.DiaryNote, error) {
	if f.createErr != nil {
		return nil, f.createErr
	}
	f.lastTagSent = tag
	f.nextID++
	n := store.DiaryNote{
		ID:        f.nextID,
		UserID:    userID,
		Content:   content,
		Tag:       tag,
		CreatedAt: time.Now(),
	}
	f.notes = append([]store.DiaryNote{n}, f.notes...)
	return &n, nil
}

func (f *fakeNotesStore) ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []store.DiaryNote
	for _, n := range f.notes {
		if n.UserID != userID {
			continue
		}
		out = append(out, n)
	}
	return out, nil
}

func (f *fakeNotesStore) DeleteDiaryNote(ctx context.Context, userID, noteID int64) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	for i, n := range f.notes {
		if n.ID == noteID && n.UserID == userID {
			f.notes = append(f.notes[:i], f.notes[i+1:]...)
			return nil
		}
	}
	return errors.New("not found")
}

func TestNormalizeNoteTag(t *testing.T) {
	valid := []string{"SLEEP", "STRESS", "HR", "SPO2", "STEPS", "NOTE"}
	for _, v := range valid {
		got := NormalizeNoteTag(&v)
		if got == nil || *got != v {
			t.Errorf("valid tag %q: got %v", v, got)
		}
	}

	cases := []struct {
		name string
		in   *string
		want *string
	}{
		{"nil in", nil, nil},
		{"empty string", strPtr(""), nil},
		{"whitespace", strPtr("   "), nil},
		{"lowercase sleep → SLEEP", strPtr("sleep"), strPtr("SLEEP")},
		{"mixed-case Stress → STRESS", strPtr("Stress"), strPtr("STRESS")},
		{"surrounding whitespace", strPtr("  hr  "), strPtr("HR")},
		{"unknown tag", strPtr("MOOD"), nil},
		{"injection attempt", strPtr("NOTE; DROP"), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeNoteTag(tc.in)
			if (got == nil) != (tc.want == nil) {
				t.Fatalf("nil mismatch: got %v want %v", got, tc.want)
			}
			if got != nil && *got != *tc.want {
				t.Errorf("got %q want %q", *got, *tc.want)
			}
		})
	}
}

func strPtr(s string) *string { return &s }

func TestNotesService_CreateNote_EmptyContent(t *testing.T) {
	svc := NewNotesService(&fakeNotesStore{})
	_, err := svc.CreateNote(context.Background(), 1, "   ", nil)
	if !errors.Is(err, ErrEmptyContent) {
		t.Errorf("expected ErrEmptyContent, got %v", err)
	}
}

func TestNotesService_CreateNote_ContentTooLong(t *testing.T) {
	svc := NewNotesService(&fakeNotesStore{})
	_, err := svc.CreateNote(context.Background(), 1, strings.Repeat("a", MaxNoteContentRunes+1), nil)
	if !errors.Is(err, ErrContentTooLong) {
		t.Errorf("expected ErrContentTooLong, got %v", err)
	}
}

func TestNotesService_CreateNote_NilTag(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	n, err := svc.CreateNote(context.Background(), 1, "hello", nil)
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if n.Tag != nil {
		t.Errorf("expected nil tag, got %v", *n.Tag)
	}
}

func TestNotesService_CreateNote_ValidTag(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	tag := "SLEEP"
	n, err := svc.CreateNote(context.Background(), 1, "hello", &tag)
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if n.Tag == nil || *n.Tag != "SLEEP" {
		t.Errorf("expected tag SLEEP, got %v", n.Tag)
	}
}

func TestNotesService_CreateNote_InvalidTagBecomesNil(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	bad := "MOOD"
	n, err := svc.CreateNote(context.Background(), 1, "hello", &bad)
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if n.Tag != nil {
		t.Errorf("expected invalid tag sanitized to nil, got %v", *n.Tag)
	}
	if fs.lastTagSent != nil {
		t.Errorf("expected store to receive nil tag, got %v", *fs.lastTagSent)
	}
}

func TestNotesService_CreateNote_LowercaseTagNormalized(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	raw := "sleep"
	n, err := svc.CreateNote(context.Background(), 1, "hello", &raw)
	if err != nil {
		t.Fatal(err)
	}
	if n.Tag == nil || *n.Tag != "SLEEP" {
		t.Errorf("expected normalized SLEEP, got %v", n.Tag)
	}
}

func TestNotesService_CreateNote_ContentTrimmed(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	n, err := svc.CreateNote(context.Background(), 1, "  spaced out  ", nil)
	if err != nil {
		t.Fatal(err)
	}
	if n.Content != "spaced out" {
		t.Errorf("expected trimmed content, got %q", n.Content)
	}
}

func TestNotesService_ListNotes(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	if _, err := svc.CreateNote(context.Background(), 1, "one", nil); err != nil {
		t.Fatal(err)
	}
	tag := "STRESS"
	if _, err := svc.CreateNote(context.Background(), 1, "two", &tag); err != nil {
		t.Fatal(err)
	}
	notes, err := svc.ListNotes(context.Background(), 1, time.Time{}, time.Time{}, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	if notes[0].Tag == nil || *notes[0].Tag != "STRESS" {
		t.Errorf("expected newest note tagged STRESS, got %v", notes[0].Tag)
	}
}

func TestNotesService_DeleteNote(t *testing.T) {
	fs := &fakeNotesStore{}
	svc := NewNotesService(fs)
	n, err := svc.CreateNote(context.Background(), 1, "drop me", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteNote(context.Background(), 1, n.ID); err != nil {
		t.Fatalf("DeleteNote: %v", err)
	}
	notes, _ := svc.ListNotes(context.Background(), 1, time.Time{}, time.Time{}, 0, 0)
	if len(notes) != 0 {
		t.Errorf("expected 0 notes after delete, got %d", len(notes))
	}
}
