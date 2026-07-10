package cloudserver

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// teardownTimeout bounds the best-effort external cleanup (the Telegram webhook
// call) so a hung third party cannot stall an account deletion.
const teardownTimeout = 10 * time.Second

// accountDeletePath is both the delete route and the re-auth cookie scope. The
// re-auth challenge cookie is scoped here so it reaches DELETE /api/account (it
// is not under /api/webauthn/login, where login challenges live).
const accountDeletePath = "/api/account"

// accountDeleteStore is the deletion the self-service route needs.
type accountDeleteStore interface {
	sessionStore // RequireSession
	DeleteAccountByID(ctx context.Context, accountID string) error
}

// AccountAPI serves self-service account deletion (med-d5t.8). Before this a
// friend who wanted out had to ask the operator to run a CLI command.
type AccountAPI struct {
	store         accountDeleteStore
	sessionSecret string
	webauthn      *WebAuthnAPI
	// teardown does the best-effort external + in-memory cleanup that a pure DB
	// delete cannot: closing MCP relay legs, disabling hosted MCP, deleting the
	// Telegram webhook. Composed in cmd/cloud so this package need not import
	// every subsystem. Nil is allowed (deletion still removes all DB rows).
	teardown func(ctx context.Context, accountID string)
}

// NewAccountAPI builds the self-service account handlers. webauthn provides the
// fresh-passkey re-auth gate; teardown may be nil.
func NewAccountAPI(store accountDeleteStore, sessionSecret string, webauthn *WebAuthnAPI, teardown func(ctx context.Context, accountID string)) *AccountAPI {
	return &AccountAPI{store: store, sessionSecret: sessionSecret, webauthn: webauthn, teardown: teardown}
}

func (a *AccountAPI) RegisterRoutes(mux *http.ServeMux) {
	// Re-auth begin: issue a fresh assertion challenge scoped to /api/account.
	mux.Handle("POST /api/account/reauth", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ReauthBegin)))
	// The delete itself: session AND a fresh passkey assertion in the body.
	mux.Handle("DELETE /api/account", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Delete)))
}

// ReauthBegin starts the fresh-passkey ceremony that DELETE /api/account
// requires. The client answers the returned assertion and posts it to Delete.
func (a *AccountAPI) ReauthBegin(w http.ResponseWriter, r *http.Request) {
	a.webauthn.BeginReauth(w, r, accountDeletePath)
}

// Delete permanently removes the caller's account and every row keyed to it.
//
// It is gated on BOTH a valid session and a FRESH passkey assertion (in the
// request body): deleting a vault must require proving you physically hold a
// registered device, so a stolen session cookie alone cannot do it (med-d5t.8).
//
// Order: verify presence, then best-effort external teardown (which still needs
// the Telegram bot token, so it must run before the DB rows are gone), then the
// authoritative single-transaction DB delete, then clear the session cookie. The
// DB delete is the source of truth — a teardown failure (Telegram unreachable,
// say) must not trap a friend in an account they asked to leave, so teardown
// failures are logged, not fatal.
func (a *AccountAPI) Delete(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if !a.webauthn.VerifyReauth(w, r, accountDeletePath) {
		return // VerifyReauth already wrote the error response.
	}

	// Best-effort: external side effects and in-memory registries. Runs before
	// the DB delete so it can still read the Telegram bot row it needs. Bounded
	// by its own timeout: teardown makes a network call to Telegram, and a hung
	// api.telegram.org must not stall the whole delete.
	if a.teardown != nil {
		tctx, cancel := context.WithTimeout(r.Context(), teardownTimeout)
		a.teardown(tctx, session.AccountID)
		cancel()
	}

	if err := a.store.DeleteAccountByID(r.Context(), session.AccountID); err != nil {
		slog.Error("account delete failed", "account", session.AccountID, "error", err)
		http.Error(w, "could not delete account", http.StatusInternalServerError)
		return
	}
	slog.Info("account deleted (self-service)", "account", session.AccountID)

	// Clear the session cookie. Deleting the credential rows already invalidates
	// the token on the next request (RequireSession's CredentialExists check),
	// but the account is gone — leave no cookie pointing at it.
	clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
