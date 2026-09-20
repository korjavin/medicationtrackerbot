package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Blind workout-share short links (med-1yi5): the sender's browser encrypts
// the plan token client-side (AES-128-GCM under a fresh key K that never
// reaches the server) and POSTs only the packed ciphertext here. The server
// mints a short capability id and serves the opaque blob back to whoever
// holds the id (+K, client-side). The server never sees K or plaintext.
const (
	// shareLinkTTL is the hand-off window: long enough to share and redeem,
	// short enough that stored ciphertext does not accumulate (the epic
	// priced 90 days at 3x the stored ciphertext for no UX gain).
	shareLinkTTL = 30 * 24 * time.Hour
	// maxShareCTLen bounds the decoded packed blob (nonce || GCM ciphertext).
	maxShareCTLen = 16384
	// maxShareBodyBytes bounds the POST body (std-base64 inflates ~4/3).
	maxShareBodyBytes = 24 << 10
	// maxLiveShareLinks caps unexpired links per account; past it POST is 429.
	maxLiveShareLinks = 100
	// shareIDLen is the short-link id length over the base62 alphabet.
	shareIDLen = 10
)

// shareIDAlphabet is [A-Za-z0-9] (~59 bits at length 10: the id only needs
// to be non-enumerable; the secret is K, carried in the URL fragment the
// server never receives).
const shareIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// shareIDPattern rejects anything but a well-formed id before the store is
// touched, so malformed reads 404 without becoming a store oracle.
var shareIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{10}$`)

// shareStore is the subset of *cloudstore.Repo the share-link endpoints need.
type shareStore interface {
	CreateShareLink(ctx context.Context, id, accountID string, ct []byte, createdAt, expiresAt time.Time) error
	ShareLink(ctx context.Context, id string, now time.Time) (ct []byte, expiresAt time.Time, err error)
	CountLiveShareLinks(ctx context.Context, accountID string, now time.Time) (int, error)
	SweepExpiredShareLinks(ctx context.Context, now time.Time) (int, error)
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
}

// ShareAPI holds the blind workout-share HTTP handlers: an authenticated
// create on the sender's account subdomain, and an unauthenticated
// capability read served on every host (account subdomains via the shared
// apiMux, the base domain via router.go's narrow /api/s/ forward).
type ShareAPI struct {
	store         shareStore
	sessionSecret string
	baseDomain    string
	limiter       *rateLimiter
}

// NewShareAPI builds the share-link handlers.
func NewShareAPI(store shareStore, sessionSecret, baseDomain string) *ShareAPI {
	return &ShareAPI{
		store:         store,
		sessionSecret: sessionSecret,
		baseDomain:    baseDomain,
		limiter:       newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
	}
}

// RegisterRoutes adds the share-link routes to mux.
func (a *ShareAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/share", RequireSession(a.store, a.sessionSecret, limitByIP(a.limiter, a.CreateShare)))
	// Unauthenticated by design: the id alone is the capability (the secret
	// K never leaves the fragment), so this read carries no account context
	// and RequireSession must NOT be on it. Per-IP rate-limit only.
	mux.HandleFunc("GET /api/s/{id}", limitByIP(a.limiter, a.GetShare))
}

type createShareRequest struct {
	CT []byte `json:"ct"`
}

type createShareResponse struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type getShareResponse struct {
	CT        []byte    `json:"ct"`
	ExpiresAt time.Time `json:"expires_at"`
}

// randomShareID draws shareIDLen chars from shareIDAlphabet with rejection
// sampling (62 does not divide 256, so a bare mod would bias the low
// letters). randomToken is hex-only and cannot be reused here.
func randomShareID() (string, error) {
	out := make([]byte, shareIDLen)
	i := 0
	// 256 = 4*62 + 8: values 248..255 are discarded to keep the draw uniform.
	var buf [32]byte
	for i < shareIDLen {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b >= 248 {
				continue
			}
			out[i] = shareIDAlphabet[int(b)%len(shareIDAlphabet)]
			i++
			if i == shareIDLen {
				break
			}
		}
	}
	return string(out), nil
}

// CreateShare stores the sender's opaque ciphertext and returns the short
// link. Expired rows are swept opportunistically on every create (transfer
// precedent, no background job). Unknown/expired reads 404 uniformly —
// GetShare, not this call, is where the oracle risk lives.
func (a *ShareAPI) CreateShare(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req createShareRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxShareBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.CT) == 0 || len(req.CT) > maxShareCTLen {
		http.Error(w, "ct field too large or missing", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if _, err := a.store.SweepExpiredShareLinks(r.Context(), now); err != nil {
		slog.Error("cloudserver: sweep expired share links", "error", err, "account_id", session.AccountID)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	live, err := a.store.CountLiveShareLinks(r.Context(), session.AccountID, now)
	if err != nil {
		slog.Error("cloudserver: count live share links", "error", err, "account_id", session.AccountID)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if live >= maxLiveShareLinks {
		http.Error(w, "share link quota exceeded", http.StatusTooManyRequests)
		return
	}

	expiresAt := now.Add(shareLinkTTL)
	var id string
	for attempt := 0; attempt < 2; attempt++ {
		id, err = randomShareID()
		if err != nil {
			slog.Error("cloudserver: generate share id", "error", err, "account_id", session.AccountID)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		err = a.store.CreateShareLink(r.Context(), id, session.AccountID, req.CT, now, expiresAt)
		if err == nil {
			break
		}
		if !errors.Is(err, cloudstore.ErrShareLinkExists) {
			slog.Error("cloudserver: create share link", "error", err, "account_id", session.AccountID)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// PK collision: retry once with a fresh id; a second collision is a 500.
		slog.Warn("cloudserver: share id collision, retrying", "account_id", session.AccountID)
	}
	if err != nil {
		slog.Error("cloudserver: share id collision twice", "account_id", session.AccountID)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, createShareResponse{
		ID:        id,
		URL:       "https://" + a.baseDomain + "/s/" + id,
		ExpiresAt: expiresAt,
	})
}

// GetShare serves a share link's opaque ciphertext to whoever holds the id.
// Malformed, unknown, and expired ids all 404 alike: the id must not become
// a validity oracle.
func (a *ShareAPI) GetShare(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || !shareIDPattern.MatchString(id) {
		http.Error(w, "share link not found", http.StatusNotFound)
		return
	}

	ct, expiresAt, err := a.store.ShareLink(r.Context(), id, time.Now().UTC())
	if err != nil {
		if errors.Is(err, cloudstore.ErrShareLinkInvalid) {
			http.Error(w, "share link not found", http.StatusNotFound)
			return
		}
		slog.Error("cloudserver: read share link", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, getShareResponse{CT: ct, ExpiresAt: expiresAt})
}
