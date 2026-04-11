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

// fetchContextNotes retrieves diary notes for the given date range.
// Returns nil (not an empty slice) when there are no notes, so the field
// is omitted from JSON when empty.
func (s *Server) fetchContextNotes(ctx context.Context, startDate, endDate time.Time) []ContextNote {
	userID := s.config.UserID
	notes, err := s.data.ListDiaryNotes(ctx, userID, startDate, endDate, 50, 0)
	if err != nil {
		slog.Warn("[MCP] Failed to fetch context notes", "error", err)
		return nil
	}
	if len(notes) == 0 {
		return nil
	}

	result := make([]ContextNote, len(notes))
	for i, n := range notes {
		result[i] = ContextNote{
			Content:   n.Content,
			CreatedAt: n.CreatedAt.Format(time.RFC3339),
		}
	}
	return result
}

// shouldIncludeNotes returns true unless the tool input has exclude_notes set to true.
func shouldIncludeNotes(excludeNotes bool) bool {
	return !excludeNotes
}
