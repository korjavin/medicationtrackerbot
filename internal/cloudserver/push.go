package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Size caps on subscription fields: endpoints are push-service URLs (well
// under 1KiB in practice); p256dh/auth are fixed-size ECDH/auth-secret keys
// base64-encoded (~88/~24 chars) — the caps are generous headroom, not a
// precise bound.
const (
	maxPushSubscriptionBodyBytes = 4 << 10
	maxPushEndpointLen           = 2048
	maxPushKeyLen                = 256

	// Schedule caps: 2000 entries covers years of daily reminders; 4KB per
	// ciphertext leaves headroom under the ~4078-byte webpush payload limit
	// once RFC 8291 overhead is subtracted.
	maxScheduleBodyBytes = 1 << 20 // 1 MiB request body (a full replace-all batch)
	maxScheduleEntries   = 2000
	maxScheduleCTLen     = 4 << 10
)

// pushStore is the subset of *cloudstore.Repo the push-subscription and
// schedule endpoints need.
type pushStore interface {
	UpsertPushSubscription(ctx context.Context, accountID, endpoint, p256dh, auth string, now time.Time) error
	DeletePushSubscription(ctx context.Context, accountID, endpoint string) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
	ReplaceSchedule(ctx context.Context, accountID string, entries []cloudstore.ScheduledPushInput, now time.Time) error
}

// PushAPI holds the push-subscription + VAPID-public-key HTTP handlers.
// Subscription routes require a valid session; the public key is served
// unauthenticated (it is not a secret — the client needs it before it has
// ever unlocked).
type PushAPI struct {
	store         pushStore
	sessionSecret string
}

// NewPushAPI builds the push handlers.
func NewPushAPI(store pushStore, sessionSecret string) *PushAPI {
	return &PushAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes adds the push routes to mux.
func (a *PushAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostSubscription)))
	mux.Handle("DELETE /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteSubscription)))
	mux.HandleFunc("GET /api/push/vapid-public-key", a.GetVapidPublicKey)
	mux.Handle("PUT /api/push/schedule", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutSchedule)))
}

type subscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

var errInvalidPushEndpoint = errors.New("invalid push endpoint")

// validatePushEndpoint blocks the obvious authenticated-SSRF vectors before an
// endpoint is stored and later POSTed to by the blind relay: a subscription is
// a client-controlled URL the server makes outbound requests to. Require https
// and reject literal-IP hosts that point at loopback / link-local (cloud
// metadata at 169.254.169.254) / private ranges.
//
// ponytail: literal-IP block only — a hostname that *resolves* to a private IP
// (DNS rebinding) still slips through; closing that needs a dial-time control
// on the relay's HTTP client, out of scope for the C0 push path where real
// endpoints are public push-service hosts.
func validatePushEndpoint(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return errInvalidPushEndpoint
	}
	host := u.Hostname()
	if host == "" {
		return errInvalidPushEndpoint
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return errInvalidPushEndpoint
		}
	}
	return nil
}

// PostSubscription registers (or refreshes) a web-push subscription for the
// caller's session account.
func (a *PushAPI) PostSubscription(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req subscriptionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPushSubscriptionBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" || len(req.Endpoint) > maxPushEndpointLen ||
		req.P256dh == "" || len(req.P256dh) > maxPushKeyLen ||
		req.Auth == "" || len(req.Auth) > maxPushKeyLen {
		http.Error(w, "subscription field too large or missing", http.StatusBadRequest)
		return
	}
	if err := validatePushEndpoint(req.Endpoint); err != nil {
		http.Error(w, "invalid endpoint", http.StatusBadRequest)
		return
	}

	if err := a.store.UpsertPushSubscription(r.Context(), session.AccountID, req.Endpoint, req.P256dh, req.Auth, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type deleteSubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
}

// DeleteSubscription removes a web-push subscription for the caller's
// session account. A body (not a path segment) carries the endpoint since it
// is an arbitrary push-service URL.
func (a *PushAPI) DeleteSubscription(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req deleteSubscriptionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPushSubscriptionBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" || len(req.Endpoint) > maxPushEndpointLen {
		http.Error(w, "invalid endpoint", http.StatusBadRequest)
		return
	}

	if err := a.store.DeletePushSubscription(r.Context(), session.AccountID, req.Endpoint); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type vapidPublicKeyResponse struct {
	PublicKey string `json:"public_key"`
}

// GetVapidPublicKey returns the calling account's VAPID public key,
// unauthenticated — the client needs it to call PushManager.subscribe()
// before any account session exists in that browser tab. The account is
// resolved from the request's subdomain by the wildcard-host router; a
// base-domain request (no account in context) 404s, as does an account
// whose keys haven't been backfilled yet (should not happen post-backfill).
func (a *PushAPI) GetVapidPublicKey(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok || account.VAPIDPublicKey == nil || *account.VAPIDPublicKey == "" {
		http.Error(w, "push not configured", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, vapidPublicKeyResponse{PublicKey: *account.VAPIDPublicKey})
}

type scheduleEntryWire struct {
	FireAtUnix int64  `json:"fire_at_unix"`
	CT         []byte `json:"ct"`
}

type putScheduleRequest struct {
	Entries []scheduleEntryWire `json:"entries"`
}

// PutSchedule replaces the caller's session account's pending push schedule:
// every not-yet-sent entry is dropped and the batch is inserted in its place
// (replace-all, mirroring the Capacitor Reminders loop). Entries the relay
// has already fired are untouched.
func (a *PushAPI) PutSchedule(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req putScheduleRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxScheduleBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Entries) > maxScheduleEntries {
		http.Error(w, "too many schedule entries", http.StatusBadRequest)
		return
	}
	entries := make([]cloudstore.ScheduledPushInput, len(req.Entries))
	for i, e := range req.Entries {
		if e.FireAtUnix <= 0 || len(e.CT) == 0 || len(e.CT) > maxScheduleCTLen {
			http.Error(w, "schedule entry field too large or missing", http.StatusBadRequest)
			return
		}
		entries[i] = cloudstore.ScheduledPushInput{FireAt: storedb.UnixToTime(e.FireAtUnix), CT: e.CT}
	}

	if err := a.store.ReplaceSchedule(r.Context(), session.AccountID, entries, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
