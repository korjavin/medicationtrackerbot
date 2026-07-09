package cloudserver

import (
	"context"
	"net/http"
	"time"
)

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
}

// NewInviteAPI builds the user-mintable invite handler.
func NewInviteAPI(store inviteStore, sessionSecret, baseDomain string, claimTTL time.Duration) *InviteAPI {
	return &InviteAPI{store: store, sessionSecret: sessionSecret, baseDomain: baseDomain, claimTTL: claimTTL}
}

// RegisterRoutes adds the invite-minting route to mux.
func (a *InviteAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/invite", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.CreateInvite)))
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
