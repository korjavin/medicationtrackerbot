package cloudserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// Size caps on subscription fields: endpoints are push-service URLs (well
// under 1KiB in practice); p256dh/auth are fixed-size ECDH/auth-secret keys
// base64-encoded (~88/~24 chars) — the caps are generous headroom, not a
// precise bound.
const (
	maxPushSubscriptionBodyBytes = 4 << 10
	maxPushEndpointLen           = 2048
	maxPushKeyLen                = 256
)

// pushStore is the subset of *cloudstore.Repo the push-subscription endpoints
// need.
type pushStore interface {
	UpsertPushSubscription(ctx context.Context, accountID, endpoint, p256dh, auth string, now time.Time) error
	DeletePushSubscription(ctx context.Context, accountID, endpoint string) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// PushAPI holds the push-subscription + VAPID-public-key HTTP handlers.
// Subscription routes require a valid session; the public key is served
// unauthenticated (it is not a secret — the client needs it before it has
// ever unlocked).
type PushAPI struct {
	store          pushStore
	sessionSecret  string
	vapidPublicKey string
}

// NewPushAPI builds the push handlers.
func NewPushAPI(store pushStore, sessionSecret, vapidPublicKey string) *PushAPI {
	return &PushAPI{store: store, sessionSecret: sessionSecret, vapidPublicKey: vapidPublicKey}
}

// RegisterRoutes adds the push routes to mux.
func (a *PushAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostSubscription)))
	mux.Handle("DELETE /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteSubscription)))
	mux.HandleFunc("GET /api/push/vapid-public-key", a.GetVapidPublicKey)
}

type subscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
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

// GetVapidPublicKey returns the service's VAPID public key, unauthenticated —
// the client needs it to call PushManager.subscribe() before any account
// session exists in that browser tab. 503 when the operator hasn't
// configured VAPID_PUBLIC_KEY (push is simply unavailable).
func (a *PushAPI) GetVapidPublicKey(w http.ResponseWriter, r *http.Request) {
	if a.vapidPublicKey == "" {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, vapidPublicKeyResponse{PublicKey: a.vapidPublicKey})
}
