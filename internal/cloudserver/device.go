package cloudserver

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// deviceStore is the subset of *cloudstore.Repo the device-list and
// revocation endpoints need.
type deviceStore interface {
	CredentialsByAccount(ctx context.Context, accountID string) ([]cloudstore.Credential, error)
	GetEnvelope(ctx context.Context, accountID, credentialRef string) (*cloudstore.Envelope, error)
	DeleteCredentialWithEnvelope(ctx context.Context, accountID string, credentialID []byte) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// DeviceAPI holds the device-list + revocation HTTP handlers. Every route
// requires a valid session (RequireSession).
type DeviceAPI struct {
	store         deviceStore
	sessionSecret string
}

// NewDeviceAPI builds the device-list handlers.
func NewDeviceAPI(store deviceStore, sessionSecret string) *DeviceAPI {
	return &DeviceAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes adds the device-list + revocation routes to mux.
func (a *DeviceAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/devices", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ListDevices)))
	mux.Handle("DELETE /api/devices/{credential_id}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteDevice)))
}

// deviceEnvelopeWire is the envelope shape nested in a device-list item — the
// client needs nonce+ct+mac (not just mac) to recompute and verify the audit
// tag (docs/cloud-crypto.md envelope-audit MAC).
type deviceEnvelopeWire struct {
	V     int    `json:"v"`
	Nonce []byte `json:"nonce"`
	CT    []byte `json:"ct"`
	MAC   []byte `json:"mac"`
}

type deviceListItem struct {
	CredentialID   string              `json:"credential_id"`
	CreatedAt      time.Time           `json:"created_at"`
	LastAssertedAt *time.Time          `json:"last_asserted_at,omitempty"`
	Envelope       *deviceEnvelopeWire `json:"envelope,omitempty"`
}

// ListDevices returns every credential registered for the caller's session
// account, joined with its DEK envelope, so the client can audit each
// device's envelope MAC and render a verified/unverified badge
// (docs/cloud-crypto.md "Malicious operator adds their own credential").
func (a *DeviceAPI) ListDevices(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	creds, err := a.store.CredentialsByAccount(r.Context(), session.AccountID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	out := make([]deviceListItem, 0, len(creds))
	for _, c := range creds {
		item := deviceListItem{
			CredentialID:   base64.RawURLEncoding.EncodeToString(c.ID),
			CreatedAt:      c.CreatedAt,
			LastAssertedAt: c.LastAssertedAt,
		}
		env, err := a.store.GetEnvelope(r.Context(), session.AccountID, item.CredentialID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if env != nil {
			item.Envelope = &deviceEnvelopeWire{V: env.V, Nonce: env.Nonce, CT: env.CT, MAC: env.MAC}
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteDevice revokes one credential: removes its WebAuthn credential and
// DEK envelope in one transaction (RequireSession then rejects any session
// token that was minted for it). Refuses to remove the account's last
// remaining credential unless a recovery envelope exists, so the account is
// never stranded with no way to unwrap the DEK.
func (a *DeviceAPI) DeleteDevice(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	credentialID, err := base64.RawURLEncoding.DecodeString(r.PathValue("credential_id"))
	if err != nil || len(credentialID) == 0 {
		http.Error(w, "invalid credential_id", http.StatusBadRequest)
		return
	}

	creds, err := a.store.CredentialsByAccount(r.Context(), session.AccountID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if len(creds) <= 1 {
		if _, err := a.store.GetEnvelope(r.Context(), session.AccountID, "recovery"); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				http.Error(w, "cannot remove the last device without a recovery code set up", http.StatusConflict)
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}

	if err := a.store.DeleteCredentialWithEnvelope(r.Context(), session.AccountID, credentialID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
