package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
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

	// Telegram reminder text is plaintext the relay forwards verbatim. 1 KiB
	// is far above any reminder the client composes and well under Telegram's
	// own 4096-char sendMessage limit.
	maxScheduleTGTextLen = 1 << 10

	// tg_med_ids is a comma-separated list of numeric medication record ids
	// (16-digit ids in practice) — 512 bytes holds ~30 of them, far more than any
	// one dose slot names.
	maxScheduleTGMedIDsLen = 512

	// Test-push body cap; the ciphertext reuses maxScheduleCTLen (same bound
	// as a single schedule entry).
	maxTestPushBodyBytes = 8 << 10
)

// pushStore is the subset of *cloudstore.Repo the push-subscription and
// schedule endpoints need.
type pushStore interface {
	UpsertPushSubscription(ctx context.Context, accountID, endpoint, p256dh, auth string, now time.Time) error
	DeletePushSubscription(ctx context.Context, accountID, endpoint string) error
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
	ReplaceSchedule(ctx context.Context, accountID string, entries []cloudstore.ScheduledPushInput, now time.Time) error
	GetByEndpoint(ctx context.Context, accountID, endpoint string) (*cloudstore.PushSubscription, error)
	Disable(ctx context.Context, endpoint string) error
	AccountVAPIDKeysByID(ctx context.Context, accountID string) (cloudstore.AccountVAPIDKeys, error)
}

// PushAPI holds the push-subscription + VAPID-public-key HTTP handlers.
// Subscription routes require a valid session; the public key is served
// unauthenticated (it is not a secret — the client needs it before it has
// ever unlocked).
type PushAPI struct {
	store         pushStore
	sender        PushSender
	sessionSecret string
	limiter       *rateLimiter
}

// NewPushAPI builds the push handlers. sender delivers the immediate
// this-device test push (Task 1); it is the same PushSender the relay uses.
func NewPushAPI(store pushStore, sender PushSender, sessionSecret string) *PushAPI {
	return &PushAPI{
		store:         store,
		sender:        sender,
		sessionSecret: sessionSecret,
		limiter:       newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
	}
}

// RegisterRoutes adds the push routes to mux.
func (a *PushAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostSubscription)))
	mux.Handle("DELETE /api/push/subscriptions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteSubscription)))
	// Unauthenticated + browser-hit (distinct client IPs): per-IP rate-limit to
	// blunt hammering. Not applied to webhooks — see the sentinel.md note.
	mux.HandleFunc("GET /api/push/vapid-public-key", limitByIP(a.limiter, a.GetVapidPublicKey))
	mux.Handle("PUT /api/push/schedule", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutSchedule)))
	mux.Handle("POST /api/push/test", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostTestPush)))
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
	r.Body = http.MaxBytesReader(w, r.Body, maxPushSubscriptionBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
	r.Body = http.MaxBytesReader(w, r.Body, maxPushSubscriptionBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

// scheduleEntryWire is one uploaded reminder. Delivery is optional — an empty
// value means "webpush", which is what every pre-C3b client sends. CT is the
// opaque NK ciphertext for web push; TGText is the plaintext the relay hands
// straight to Telegram (see cloudstore.ScheduledPush).
type scheduleEntryWire struct {
	FireAtUnix int64  `json:"fire_at_unix"`
	CT         []byte `json:"ct"`
	Delivery   string `json:"delivery"`
	TGText     string `json:"tg_text"`
	TGCallback string `json:"tg_callback"`
	// TGMedIDs names the medications this reminder's text is about, so a Telegram
	// Confirm tap seals their identity instead of the browser reconstructing it
	// (med-kbpf). Cleartext to the relay, like TGText — see the migration comment
	// in 022_push_med_ids.sql for the privacy trade-off.
	TGMedIDs string `json:"tg_med_ids"`
}

// tgMedIDsPattern is the ONLY shape tg_med_ids may take: bare decimal record ids,
// comma separated. Anything else is rejected rather than stored — the value ends
// up inside a sealed inbox event the client parses.
var tgMedIDsPattern = regexp.MustCompile(`^[0-9]+(,[0-9]+)*$`)

// validTGMedIDs accepts an empty list (every non-med entry, and any client that
// predates med-kbpf) or a bounded comma-separated id list.
func validTGMedIDs(s string) bool {
	return s == "" || (len(s) <= maxScheduleTGMedIDsLen && tgMedIDsPattern.MatchString(s))
}

type putScheduleRequest struct {
	Entries []scheduleEntryWire `json:"entries"`
}

// PutSchedule replaces the caller's session account's pending push schedule:
// every not-yet-sent entry is dropped and the batch is inserted in its place
// (replace-all). Entries the relay
// has already fired are untouched.
func (a *PushAPI) PutSchedule(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req putScheduleRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxScheduleBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Entries) > maxScheduleEntries {
		http.Error(w, "too many schedule entries", http.StatusBadRequest)
		return
	}
	entries := make([]cloudstore.ScheduledPushInput, len(req.Entries))
	for i, e := range req.Entries {
		delivery := e.Delivery
		if delivery == "" {
			delivery = cloudstore.DeliveryWebPush
		}
		if e.FireAtUnix <= 0 || !cloudstore.ValidDelivery(delivery) {
			http.Error(w, "schedule entry field invalid or missing", http.StatusBadRequest)
			return
		}
		// Each channel requires its own payload: web push can only fire the
		// ciphertext, Telegram can only fire the plaintext.
		needsCT := delivery == cloudstore.DeliveryWebPush || delivery == cloudstore.DeliveryBoth
		needsText := delivery == cloudstore.DeliveryTelegram || delivery == cloudstore.DeliveryBoth
		if needsCT && (len(e.CT) == 0 || len(e.CT) > maxScheduleCTLen) {
			http.Error(w, "schedule entry field too large or missing", http.StatusBadRequest)
			return
		}
		if needsText && (e.TGText == "" || len(e.TGText) > maxScheduleTGTextLen) {
			http.Error(w, "schedule entry field too large or missing", http.StatusBadRequest)
			return
		}
		if !needsCT && len(e.CT) > maxScheduleCTLen {
			http.Error(w, "schedule entry field too large or missing", http.StatusBadRequest)
			return
		}
		// tg_callback becomes callback_data on an inline button, so it is only
		// ever the "s:<slotUnix>" stem this server knows how to parse back.
		// Rejecting anything else here keeps arbitrary client bytes out of the
		// buttons the relay sends on the user's behalf.
		if !tgclient.ValidCallbackStem(e.TGCallback) {
			http.Error(w, "schedule entry field invalid or missing", http.StatusBadRequest)
			return
		}
		// Med identity only makes sense on a med row: it is what a "s:<slot>" tap
		// resolves against, and nothing else has a tap to resolve.
		if !validTGMedIDs(e.TGMedIDs) || (e.TGMedIDs != "" && !strings.HasPrefix(e.TGCallback, tgclient.CallbackSlotPrefix)) {
			http.Error(w, "schedule entry field invalid or missing", http.StatusBadRequest)
			return
		}
		entries[i] = cloudstore.ScheduledPushInput{
			FireAt:     storedb.UnixToTime(e.FireAtUnix),
			CT:         e.CT,
			Delivery:   delivery,
			TGText:     e.TGText,
			TGCallback: e.TGCallback,
			TGMedIDs:   e.TGMedIDs,
		}
	}

	if err := a.store.ReplaceSchedule(r.Context(), session.AccountID, entries, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type testPushRequest struct {
	Endpoint string `json:"endpoint"`
	CT       []byte `json:"ct"`
}

// PostTestPush sends ct immediately to the caller's own subscription
// (identified by endpoint), never fanning out to the account's other
// devices — the "this-device-only" test affordance. It reuses the same
// PushSender + per-account VAPID keys as the blind relay, so the send is
// indistinguishable on the wire from a real scheduled push.
func (a *PushAPI) PostTestPush(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req testPushRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxTestPushBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" || len(req.Endpoint) > maxPushEndpointLen || len(req.CT) == 0 || len(req.CT) > maxScheduleCTLen {
		http.Error(w, "request field too large or missing", http.StatusBadRequest)
		return
	}

	sub, err := a.store.GetByEndpoint(r.Context(), session.AccountID, req.Endpoint)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if sub == nil {
		http.Error(w, "subscription not found", http.StatusNotFound)
		return
	}

	keys, err := a.store.AccountVAPIDKeysByID(r.Context(), session.AccountID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if keys.PublicKey == "" || keys.PrivateKey == "" {
		http.Error(w, "push not configured", http.StatusInternalServerError)
		return
	}

	sendCtx, cancel := context.WithTimeout(r.Context(), relaySendTimeout)
	defer cancel()
	status, err := a.sender.Send(sendCtx, *sub, keys, req.CT)
	if err != nil {
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	if status == http.StatusNotFound || status == http.StatusGone {
		if err := a.store.Disable(r.Context(), sub.Endpoint); err != nil {
			slog.Error("test push: disable stale subscription", "endpoint_fp", endpointFingerprint(sub.Endpoint), "error", err)
		}
		http.Error(w, "subscription expired", http.StatusGone)
		return
	}
	if status/100 != 2 {
		slog.Warn("test push: push service rejected send", "endpoint_fp", endpointFingerprint(sub.Endpoint), "status", status)
		http.Error(w, "push service rejected send", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
