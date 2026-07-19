package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// maxFeedbackBodyBytes caps a single feedback POST. The large case is a
// screenshot + voice-note ciphertext (med-dni.2 attachments); adjust if that
// bead's attachment limits differ.
const maxFeedbackBodyBytes = 5 << 20

// feedbackStore is the narrow slice of cloudstore the feedback API writes to.
// sessionStore comes along because RequireSession needs it.
type feedbackStore interface {
	sessionStore
	AppendFeedback(ctx context.Context, accountID, clientID, kind, appVersion string, ciphertext []byte, now time.Time) error
}

// FeedbackAPI accepts blind, client-age-encrypted feedback blobs and appends
// them to the server's opaque queue (bd med-dni.1). recipient is the developer's
// age recipient pubkey; when empty the whole feature is disabled and the
// endpoint 503s (the client also hides the UI when the meta tag is absent).
type FeedbackAPI struct {
	store         feedbackStore
	sessionSecret string
	recipient     string
}

func NewFeedbackAPI(store feedbackStore, sessionSecret, recipient string) *FeedbackAPI {
	return &FeedbackAPI{store: store, sessionSecret: sessionSecret, recipient: recipient}
}

func (a *FeedbackAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/feedback", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.SubmitFeedback)))
}

type submitFeedbackRequest struct {
	ClientID   string `json:"client_id"`
	Kind       string `json:"kind"`
	AppVersion string `json:"app_version"`
	Ciphertext []byte `json:"ciphertext"` // base64 of the opaque age-encrypted blob
}

// SubmitFeedback stores one blind feedback blob scoped to the session account.
// The ciphertext is opaque bytes — the server has no age private key, so it can
// never read it. Idempotent on client_id (AppendFeedback dedupes), so the
// reliable-retry client (med-dni.3) can safely re-POST over a flaky connection.
func (a *FeedbackAPI) SubmitFeedback(w http.ResponseWriter, r *http.Request) {
	if a.recipient == "" {
		http.Error(w, "feedback disabled", http.StatusServiceUnavailable)
		return
	}
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxFeedbackBodyBytes)
	var req submitFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "feedback too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	// `Ciphertext []byte` already means the JSON value must be valid base64 that
	// decoded to non-empty bytes; a client_id is required to make retries safe.
	if req.ClientID == "" || len(req.Ciphertext) == 0 {
		http.Error(w, "client_id and ciphertext required", http.StatusBadRequest)
		return
	}

	if err := a.store.AppendFeedback(r.Context(), session.AccountID, req.ClientID, req.Kind, req.AppVersion, req.Ciphertext, time.Now()); err != nil {
		if errors.Is(err, cloudstore.ErrFeedbackQueueFull) {
			http.Error(w, "feedback queue full", http.StatusTooManyRequests)
			return
		}
		slog.Error("feedback: append", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
