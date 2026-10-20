package cloudserver

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// inviteSubPattern is the subdomain shape the invite landing path and status
// API accept (the pinned contract's ^/i/([a-z0-9-]+)$).
var inviteSubPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// inviteStatusPathPrefix is GET /api/i/{sub}, the landing page's status read.
const inviteStatusPathPrefix = "/api/i/"

// inviteMonthlyQuota caps how many invites one account may mint per rolling
// inviteQuotaWindow. ponytail: hardcoded — env-var knob only if someone asks.
const inviteMonthlyQuota = 100

const inviteQuotaWindow = 30 * 24 * time.Hour

// inviteStore is the subset of *cloudstore.Repo the invite endpoint needs:
// the provisioning writes, the quota counter, and RequireSession's credential
// check.
type inviteStore interface {
	provisionStore
	sessionStore
	CountAccountsCreatedBy(ctx context.Context, accountID string, since time.Time) (int, error)
	AccountBySubdomain(ctx context.Context, subdomain string) (*cloudstore.Account, error)
}

// InviteAPI lets a signed-in account mint an invite for a friend from its own
// subdomain — the same Provision path as the admin CLI, with the caller
// recorded as the creator so the rolling quota can be counted from the DB
// (surviving restarts, unlike the in-memory per-IP limiter).
type InviteAPI struct {
	store         inviteStore
	sessionSecret string
	baseDomain    string
	claimTTL      time.Duration

	// mintMu serializes the count-then-insert in CreateInvite; without it
	// concurrent mints all read a sub-quota count and all insert.
	// ponytail: one global lock — cmd/cloud is a single process and minting is
	// rare. Move the count into Provision's transaction if this ever contends.
	mintMu sync.Mutex

	statusLimiter *rateLimiter // per-IP cap on the unauthenticated GET /api/i/{sub}
}

// NewInviteAPI builds the user-mintable invite handler.
func NewInviteAPI(store inviteStore, sessionSecret, baseDomain string, claimTTL time.Duration) *InviteAPI {
	return &InviteAPI{
		store: store, sessionSecret: sessionSecret, baseDomain: baseDomain, claimTTL: claimTTL,
		statusLimiter: newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
	}
}

// RegisterRoutes adds the invite-minting route and the landing page's status
// read to mux. The status read is served on the base domain only (router.go
// forwards /api/i/ from there and refuses it on account hosts).
func (a *InviteAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/invite", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.CreateInvite)))
	mux.HandleFunc("GET /api/i/{sub}", limitByIP(a.statusLimiter, a.InviteStatus))
}

type inviteStatusResponse struct {
	State     string     `json:"state"` // pending | expired | claimed
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// InviteStatus answers the invite landing page (bd med-ta2n.9): is the invite
// for this subdomain still claimable? Unauthenticated and token-free — the
// token stays in the landing URL's fragment and is never sent here. An unknown
// or malformed subdomain answers "expired", indistinguishable from a swept
// invite (the account host already reveals existence via X-Account-Gone, so
// this is no worse). expires_at is sent only for a pending invite, so an
// expired-but-unswept row looks exactly like an unknown one. No sweep: the
// state is computed from the row's own expiry, which gives the same answer
// without a write on an anonymous GET.
func (a *InviteAPI) InviteStatus(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	sub := r.PathValue("sub")
	if !inviteSubPattern.MatchString(sub) {
		writeJSON(w, http.StatusOK, inviteStatusResponse{State: "expired"})
		return
	}
	acc, err := a.store.AccountBySubdomain(r.Context(), sub)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeJSON(w, http.StatusOK, inviteStatusResponse{State: "expired"})
	case err != nil:
		slog.Error("cloudserver: invite status lookup", "error", err, "subdomain", sub)
		http.Error(w, "server error", http.StatusInternalServerError)
	case acc.ClaimTokenHash == nil:
		writeJSON(w, http.StatusOK, inviteStatusResponse{State: "claimed"})
	case acc.ClaimExpiresAt == nil || !time.Now().Before(*acc.ClaimExpiresAt):
		writeJSON(w, http.StatusOK, inviteStatusResponse{State: "expired"})
	default:
		exp := acc.ClaimExpiresAt.UTC()
		writeJSON(w, http.StatusOK, inviteStatusResponse{State: "pending", ExpiresAt: &exp})
	}
}

type inviteResponse struct {
	Subdomain string    `json:"subdomain"`
	ClaimURL  string    `json:"claim_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type inviteQuotaError struct {
	Error      string `json:"error"`
	Limit      int    `json:"limit"`
	WindowDays int    `json:"window_days"`
}

// CreateInvite provisions a fresh unclaimed account owned by nobody yet and
// returns its claim URL. The claim token exists only in this response — the
// store holds its hash — so it travels in the URL fragment, never in logs.
func (a *InviteAPI) CreateInvite(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	a.mintMu.Lock()
	defer a.mintMu.Unlock()

	now := time.Now().UTC()
	// Sweep before counting, not just inside Provision: an account sitting at
	// the quota never reaches Provision, so without this its expired unclaimed
	// invites would keep occupying slots until some other account's mint swept
	// them.
	if _, err := a.store.SweepExpiredClaims(r.Context(), now); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	minted, err := a.store.CountAccountsCreatedBy(r.Context(), session.AccountID, now.Add(-inviteQuotaWindow))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if minted >= inviteMonthlyQuota {
		writeJSON(w, http.StatusTooManyRequests, inviteQuotaError{
			Error:      "invite limit reached",
			Limit:      inviteMonthlyQuota,
			WindowDays: int(inviteQuotaWindow / (24 * time.Hour)),
		})
		return
	}

	inv, err := Provision(r.Context(), a.store, a.claimTTL, now, session.AccountID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, inviteResponse{
		Subdomain: inv.Account.Subdomain,
		ClaimURL:  inv.ClaimURL(a.baseDomain),
		ExpiresAt: *inv.Account.ClaimExpiresAt,
	})
}
