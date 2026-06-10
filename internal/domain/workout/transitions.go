package workout

import (
	"errors"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Sentinel errors returned by the session-transition methods so the transport
// layer can map each to the exact HTTP status it returned before extraction.
var (
	// ErrInvalidSessionStatus is returned by SetSessionStatus for a status
	// outside {in_progress, completed, skipped}. Handlers map it to 400.
	ErrInvalidSessionStatus = errors.New("invalid session status")
	// ErrSessionNotFound is returned by NextVariant when the session is missing.
	// Handlers map it to 404.
	ErrSessionNotFound = errors.New("session not found")
	// ErrVariantChangeNotAllowed is returned by NextVariant when the session is
	// already active or finished. Handlers map it to 400.
	ErrVariantChangeNotAllowed = errors.New("cannot change variant for an active or completed session")
	// ErrGroupNotFound is returned by NextVariant when the session's group cannot
	// be loaded. Handlers map it to 404.
	ErrGroupNotFound = errors.New("workout group not found")
	// ErrGroupNotRotating is returned by NextVariant when the group does not use
	// rotation. Handlers map it to 400.
	ErrGroupNotRotating = errors.New("workout group does not use rotation")
)

// validSessionStatuses is the set of statuses SetSessionStatus accepts — the
// final/active states the web UI and MCP registry transition sessions into.
var validSessionStatuses = map[string]bool{
	"in_progress": true,
	"completed":   true,
	"skipped":     true,
}

// Outcome reports the result of a SetSessionStatus transition so the transport
// layer can decide on follow-up side effects (notification cleanup) without
// re-reading the session. Notification dispatch itself stays in the handler.
type Outcome struct {
	// Session is the session as it was loaded before the transition.
	Session *store.WorkoutSession
	// Terminal is true when the new status is skipped or completed, signalling
	// the handler to clean up bot state and close notifications.
	Terminal bool
}

// SetSessionStatus validates and applies a session status transition. Invalid
// statuses return ErrInvalidSessionStatus (400); a missing session returns
// (nil, nil) (404). For skipped/completed it reuses SkipSession/CompleteSession
// so the rotation advances for rotating groups; for in_progress it performs a
// plain status update with no compound logic — matching the pre-extraction
// handler exactly.
func (s *Service) SetSessionStatus(sessionID int64, status string) (*Outcome, error) {
	if !validSessionStatuses[status] {
		return nil, ErrInvalidSessionStatus
	}

	session, err := s.store.GetSession(sessionID)
	if err != nil || session == nil {
		// Read error and missing row both surface as "not found" — the legacy
		// handler mapped `err != nil || session == nil` to 404.
		return nil, nil
	}

	switch status {
	case "skipped":
		if err := s.SkipSession(sessionID); err != nil {
			return nil, err
		}
	case "completed":
		if err := s.CompleteSession(sessionID); err != nil {
			return nil, err
		}
	default: // in_progress
		if err := s.store.UpdateSessionStatus(sessionID, status); err != nil {
			return nil, err
		}
	}

	return &Outcome{Session: session, Terminal: status == "skipped" || status == "completed"}, nil
}

// PreSkipSession marks a session as pre-skipped — a reversible "about to skip"
// state. Ownership/existence is verified by the transport layer.
func (s *Service) PreSkipSession(sessionID int64) error {
	return s.store.PreSkipSession(sessionID)
}

// CancelPreSkipSession reverts a pre-skipped session back to pending.
func (s *Service) CancelPreSkipSession(sessionID int64) error {
	return s.store.CancelPreSkip(sessionID)
}

// NextVariant advances a rotating group's rotation and deletes the current
// (not-yet-started) session so the next reminder surfaces the next variant.
// The status/group/rotation checks return sentinel errors the handler maps to
// the same 400/404 responses the original handler produced. Ownership is
// verified by the transport layer before this is called.
func (s *Service) NextVariant(sessionID int64) error {
	session, err := s.store.GetSession(sessionID)
	if err != nil || session == nil {
		return ErrSessionNotFound
	}
	if session.Status == "in_progress" || session.Status == "completed" || session.Status == "skipped" {
		return ErrVariantChangeNotAllowed
	}

	group, err := s.store.GetGroup(session.GroupID)
	if err != nil || group == nil {
		return ErrGroupNotFound
	}
	if !group.IsRotating {
		return ErrGroupNotRotating
	}

	if err := s.store.AdvanceRotation(group.ID); err != nil {
		return err
	}
	return s.store.DeleteSession(sessionID)
}
