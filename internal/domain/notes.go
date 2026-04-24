package domain

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrEmptyContent is returned when a note's content is empty after trimming.
var ErrEmptyContent = errors.New("note content is required")

// ErrContentTooLong is returned when a note's content exceeds the 10,000 rune limit.
var ErrContentTooLong = errors.New("note content too long")

// MaxNoteContentRunes bounds note content length. Matches the HTTP request limit.
const MaxNoteContentRunes = 10000

// ValidNoteTags is the canonical enum of note tags recognized by the product.
// Values that are not in this set are sanitized to NULL by the service, not rejected.
var ValidNoteTags = []string{"SLEEP", "STRESS", "HR", "SPO2", "STEPS", "NOTE"}

var validNoteTagSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(ValidNoteTags))
	for _, t := range ValidNoteTags {
		m[t] = struct{}{}
	}
	return m
}()

// NormalizeNoteTag trims and upper-cases the raw tag, returning nil if the
// result is empty or not one of the known enum values. The caller is free to
// treat an invalid tag as "no tag" rather than rejecting the request.
func NormalizeNoteTag(raw *string) *string {
	if raw == nil {
		return nil
	}
	t := strings.ToUpper(strings.TrimSpace(*raw))
	if t == "" {
		return nil
	}
	if _, ok := validNoteTagSet[t]; !ok {
		return nil
	}
	return &t
}

// NotesStore is the narrow store interface required by NotesService.
type NotesStore interface {
	CreateDiaryNote(ctx context.Context, userID int64, content string, tag *string) (*store.DiaryNote, error)
	ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error)
	DeleteDiaryNote(ctx context.Context, userID, noteID int64) error
}

// NotesService is the public interface for diary-note business logic.
// The HTTP handler and the bot /note command both route through this service.
type NotesService interface {
	// CreateNote validates content length, normalizes the tag (invalid tags
	// become nil), and persists the note. Returns ErrEmptyContent or
	// ErrContentTooLong for bad input.
	CreateNote(ctx context.Context, userID int64, content string, tag *string) (*store.DiaryNote, error)

	// ListNotes returns the user's notes newest-first, paginated with the
	// standard since/until/limit/beforeID contract.
	ListNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error)

	// DeleteNote deletes a note owned by the user. Returns the store's
	// sql.ErrNoRows when the note does not exist or is not owned by the user.
	DeleteNote(ctx context.Context, userID, noteID int64) error
}

type notesService struct {
	store NotesStore
}

// NewNotesService creates a new NotesService backed by the given store.
func NewNotesService(s NotesStore) NotesService {
	return &notesService{store: s}
}

func (s *notesService) CreateNote(ctx context.Context, userID int64, content string, tag *string) (*store.DiaryNote, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, ErrEmptyContent
	}
	if utf8.RuneCountInString(content) > MaxNoteContentRunes {
		return nil, ErrContentTooLong
	}
	return s.store.CreateDiaryNote(ctx, userID, content, NormalizeNoteTag(tag))
}

func (s *notesService) ListNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error) {
	return s.store.ListDiaryNotes(ctx, userID, since, until, limit, beforeID)
}

func (s *notesService) DeleteNote(ctx context.Context, userID, noteID int64) error {
	return s.store.DeleteDiaryNote(ctx, userID, noteID)
}
