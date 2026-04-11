package mcp

import (
	"context"
	"log/slog"
	"time"
)

// ContextNote represents a diary note included as context in tool responses.
type ContextNote struct {
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// notesLimit is the maximum number of diary notes returned per query.
const notesLimit = 50

// notesUnavailableWarning is surfaced when diary notes could not be fetched.
const notesUnavailableWarning = "Diary notes unavailable due to a database error; notes may be missing from this response."

// fetchContextNotes retrieves diary notes for the given date range.
// Returns nil (not an empty slice) when there are no notes, so the field
// is omitted from JSON when empty. When more notes exist than the limit,
// truncated is set to true in the second return value. The third return
// value is a non-empty warning string when notes could not be fetched.
func (s *Server) fetchContextNotes(ctx context.Context, startDate, endDate time.Time) ([]ContextNote, bool, string) {
	userID := s.config.UserID
	// Fetch one extra to detect truncation.
	notes, err := s.data.ListDiaryNotes(ctx, userID, startDate, endDate, notesLimit+1, 0)
	if err != nil {
		slog.Warn("[MCP] Failed to fetch context notes", "error", err)
		return nil, false, notesUnavailableWarning
	}
	if len(notes) == 0 {
		return nil, false, ""
	}

	truncated := len(notes) > notesLimit
	if truncated {
		notes = notes[:notesLimit]
	}

	result := make([]ContextNote, len(notes))
	for i, n := range notes {
		result[i] = ContextNote{
			Content:   n.Content,
			CreatedAt: n.CreatedAt.Format(time.RFC3339),
		}
	}
	return result, truncated, ""
}

// notesTruncatedWarning is appended when diary notes exceed the per-query limit.
const notesTruncatedWarning = "Diary notes truncated to 50 most recent entries; older notes in this period were omitted."

// shouldIncludeNotes returns true unless the tool input has exclude_notes set to true.
func shouldIncludeNotes(excludeNotes bool) bool {
	return !excludeNotes
}
