package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// maxNXKUploadBytes caps the multipart upload. nxk.ValidateImportFile enforces
// the real 100MB parse cap; this is a coarse transport guard so a hostile client
// cannot stream unbounded bytes before we ever stat the file. Slack over 100MB
// leaves room for the multipart envelope.
const maxNXKUploadBytes = 110 << 20

// vitalsImportStore is the narrow slice of cloudstore the upload endpoint needs:
// sessionStore for RequireSession and InboxQueue for SealAndQueue.
type vitalsImportStore interface {
	sessionStore
	InboxQueue
}

// VitalsImportAPI accepts a Mi Band .nxk backup upload, parses it server-side
// (transient plaintext — same trust model as the Telegram inbound path), and
// seals the mapped vitals streams into the account's inbox. The client drains
// and writes them into vault vitals records. GPS is never sealed.
type VitalsImportAPI struct {
	store         vitalsImportStore
	sessionSecret string
}

func NewVitalsImportAPI(store vitalsImportStore, sessionSecret string) *VitalsImportAPI {
	return &VitalsImportAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes mounts the session-gated import route.
func (a *VitalsImportAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/vitals/import", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Import)))
}

type vitalsImportResponse struct {
	Queued int `json:"queued"`
}

// Import reads the uploaded .nxk, parses it into sealed vitals events, and
// queues each to the caller's inbox. On no published inbox key it returns 412
// (Precondition Failed) and stores nothing — never plaintext.
func (a *VitalsImportAPI) Import(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Preflight the inbox key BEFORE reading the body — with no published key we
	// have nothing to seal to, so parsing would write the plaintext .nxk to temp
	// only to drop it. Refuse up front (mirrors the Telegram sealNXKDocument
	// check) so no plaintext ever hits disk. A key deleted between here and the
	// seal below is still caught by the ErrNoInboxKey branch.
	if pub, err := a.store.AccountInboxPublicKey(r.Context(), session.AccountID); err != nil {
		slog.Error("vitals import: read inbox key", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	} else if len(pub) == 0 {
		http.Error(w, "unlock the app on a device first to publish an inbox key", http.StatusPreconditionFailed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxNXKUploadBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file upload", http.StatusBadRequest)
		return
	}
	defer file.Close()
	// FormFile parses with a 32MB in-memory cap; a larger .nxk spills to a temp
	// file under r.MultipartForm that we must remove ourselves, or every big
	// upload strands a copy in os.TempDir (mirrors elevenlabs_handlers.go).
	defer r.MultipartForm.RemoveAll()

	tmp, err := os.CreateTemp("", "nxk-upload-*"+extForUpload(header.Filename))
	if err != nil {
		slog.Error("vitals import: create temp", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, file); err != nil {
		tmp.Close()
		slog.Error("vitals import: write temp", "accountID", session.AccountID, "error", err)
		http.Error(w, "upload failed", http.StatusBadRequest)
		return
	}
	tmp.Close()

	events, err := parseNXKToVitalsEvents(tmpPath)
	if err != nil {
		// Parse/validation errors are the client's fault (bad file); never leak
		// internals but distinguish from a server fault.
		slog.Warn("vitals import: parse", "accountID", session.AccountID, "error", err)
		http.Error(w, "could not parse backup file", http.StatusBadRequest)
		return
	}

	queued, err := a.sealEvents(r.Context(), session.AccountID, events)
	switch {
	case errors.Is(err, ErrNoInboxKey):
		// No unlocked client → no key to seal to. Refuse rather than store
		// plaintext (mirrors the Telegram setupMessage drop).
		http.Error(w, "unlock the app on a device first to publish an inbox key", http.StatusPreconditionFailed)
		return
	case err != nil:
		slog.Error("vitals import: seal", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	slog.Info("vitals import: queued", "accountID", session.AccountID, "events", queued)
	writeJSON(w, http.StatusOK, vitalsImportResponse{Queued: queued})
}

// sealEvents stamps each event with the server clock and SealAndQueue's it.
func (a *VitalsImportAPI) sealEvents(ctx context.Context, accountID string, events []vitalsImportEvent) (int, error) {
	now := time.Now().UTC()
	for i, ev := range events {
		ev.AtUnix = now.Unix()
		plaintext, err := json.Marshal(ev)
		if err != nil {
			return i, err
		}
		if err := SealAndQueue(ctx, a.store, accountID, plaintext, now); err != nil {
			return i, err
		}
	}
	return len(events), nil
}

// extForUpload preserves .nxk vs .sqlite so nxk.ValidateImportFile (called by
// parseNXKToVitalsEvents) sees the right extension on the temp path.
func extForUpload(name string) string {
	if strings.HasSuffix(strings.ToLower(name), ".sqlite") {
		return ".sqlite"
	}
	return ".nxk"
}
