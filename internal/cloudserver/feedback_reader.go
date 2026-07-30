package cloudserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// The reader capability (bd med-rbl.1). cmd/cloud has no admin accounts and no
// admin HTTP surface, so the short-lived token IS the capability, delivered over
// an already-authenticated channel — the developer's own Telegram DM.
const (
	// feedbackReaderTokenTTL bounds a minted token. Long enough to open the DM
	// link, fetch the queue and paste the age key; short enough that a link
	// sitting in a chat history is dead by the time anyone else sees it.
	feedbackReaderTokenTTL = 30 * time.Minute

	// feedbackReaderTokenHeader carries the token on the queue request. A HEADER,
	// never a query parameter: query strings land in access logs, proxy logs and
	// Referer headers, and this token is the entire authentication.
	feedbackReaderTokenHeader = "X-Feedback-Reader-Token"

	// feedbackReaderPath is the base-domain reader page, and
	// feedbackQueuePath the ciphertext endpoint it fetches. Both live on the base
	// domain: web feedback is anonymous, so there is no account to scope them to.
	feedbackReaderPath = "/feedback"
	feedbackQueuePath  = "/api/feedback/queue"

	// feedbackAgeVendorPath is the one web/static asset the base domain serves.
	// The reader page decrypts with the vendored typage bundle, and /static/*
	// otherwise only exists on account subdomains; copying the 150 KB bundle into
	// web/cloud/vendor would be a second copy to drift. Exactly this path, not a
	// /static/ prefix — the base domain has no business serving the app tree.
	feedbackAgeVendorPath = "/static/vendor/age.min.js"

	// feedbackQueueLimit bounds one queue response — the same ceiling as the
	// per-account queue cap, so one account's full queue still renders in one
	// page. The queue is NOT globally bounded by that cap, which is why the read
	// is newest-first (ListRecentFeedback): past this many undrained rows an
	// oldest-first window would hide the very item the DM announced.
	feedbackQueueLimit = 100

	// feedbackAckMaxBody bounds the ack request body. It carries nothing but a
	// list of integer ids, and the list itself is capped at feedbackQueueLimit,
	// so a few KB is already an order of magnitude more than a full page needs.
	feedbackAckMaxBody = 8 << 10
)

// feedbackReaderStore is the narrow slice of cloudstore the reader endpoint
// needs. It can read the queue and ack (delete) drained rows, but it cannot
// mint tokens — only the Telegram ping path does that, so a stolen reader token
// can never extend its own life.
type feedbackReaderStore interface {
	FeedbackReaderTokenValid(ctx context.Context, tokenHash []byte, now time.Time) (bool, error)
	ListRecentFeedback(ctx context.Context, limit int) ([]cloudstore.FeedbackItem, error)
	DeleteFeedback(ctx context.Context, id int64) error
}

// feedbackReaderMinter is the write half, used by the Telegram ping path only.
type feedbackReaderMinter interface {
	MintFeedbackReaderToken(ctx context.Context, tokenHash []byte, now, expiresAt time.Time) error
}

// mintFeedbackReaderToken generates a fresh reader token, stores only its
// SHA-256, and returns the raw token for the caller to put in the DM link.
//
// randomSecret() is 16 crypto/rand bytes hex-encoded — 128 bits. That is ample
// here: the token is unguessable (an online search of 2^128 against a 30-minute
// window is not a threat), and unlike a long-lived credential there is nothing
// to weaken it over time.
func mintFeedbackReaderToken(ctx context.Context, store feedbackReaderMinter, now time.Time) (string, error) {
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	if err := store.MintFeedbackReaderToken(ctx, sum[:], now, now.Add(feedbackReaderTokenTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// FeedbackReaderAPI serves the queued web-feedback CIPHERTEXT to a holder of a
// live reader token. It stays zero-knowledge: the response is the same opaque
// age blobs the server stored, and the age private key that opens them never
// leaves the developer's browser (see web/cloud/js/feedback-reader.js).
//
// GET lists the queue; DELETE acks items the page has finished reading
// (bd med-rbl.3). Both verbs are the same capability, gated by the same token.
type FeedbackReaderAPI struct {
	store feedbackReaderStore
}

func NewFeedbackReaderAPI(store feedbackReaderStore) *FeedbackReaderAPI {
	return &FeedbackReaderAPI{store: store}
}

// feedbackQueueItem is one row as the reader page sees it.
//
// There is deliberately NO account_id field. Web feedback is anonymous by design
// (see the comment on NotifyFeedback) and this endpoint must not become the
// thing that de-anonymizes it — cmd/feedbackpull, which runs on the operator's
// own machine against the DB, remains the only place the account attribution is
// visible.
type feedbackQueueItem struct {
	ID            int64  `json:"id"`
	Kind          string `json:"kind"`
	AppVersion    string `json:"app_version"`
	CreatedAt     string `json:"created_at"`
	CiphertextB64 string `json:"ciphertext_b64"`
}

// authorized checks the capability token and writes the failure response
// itself, so read and ack cannot diverge on how they gate. It reports whether
// the caller may proceed.
func (a *FeedbackReaderAPI) authorized(w http.ResponseWriter, r *http.Request) bool {
	token := r.Header.Get(feedbackReaderTokenHeader)
	if token == "" {
		// Same body as a wrong token: this endpoint is unauthenticated, and a
		// body distinguishing "missing" from "expired" from "unknown" only helps
		// whoever is probing it.
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	sum := sha256.Sum256([]byte(token))
	ok, err := a.store.FeedbackReaderTokenValid(r.Context(), sum[:], time.Now().UTC())
	if err != nil {
		slog.Error("feedback reader: validate token", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return false
	}
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// ack deletes exactly the ids the reader page names — the items it has already
// decrypted AND painted (bd med-rbl.3).
//
// The ordering rule is the point, and it necessarily lives in the CLIENT: this
// process never sees plaintext, so it cannot verify that anything was read. It
// mirrors cmd/feedbackpull's run(), which renders into a buffer and writes it
// before acking so a failed write cannot destroy the only copy of the feedback.
// What the server contributes is staying narrow: an explicit id list only, with
// no "drain everything" or "delete older than" shortcut that could ack rows
// nobody has looked at.
func (a *FeedbackReaderAPI) ack(w http.ResponseWriter, r *http.Request) {
	// A body on DELETE: the ids are the resource selector, and the alternative
	// (a query string) would put them in every access log for no gain.
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, feedbackAckMaxBody)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(body.IDs) == 0 || len(body.IDs) > feedbackQueueLimit {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// ponytail: one DELETE per id instead of a built IN (...) list — the list is
	// capped at feedbackQueueLimit and this table sees a handful of rows a week.
	for _, id := range body.IDs {
		if err := a.store.DeleteFeedback(r.Context(), id); err != nil {
			slog.Error("feedback reader: ack item", "error", err, "id", id)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	// Count only. Echoing the rows back would put kind/created_at — and the
	// temptation to add attribution — on a response that has no reason to carry
	// anything: web feedback is anonymous (see feedbackQueueItem).
	//
	// "acked", not "deleted": DeleteFeedback is a no-op on a row that is already
	// gone (a second tab, a retried tap), so this is how many ids were accepted,
	// not how many rows existed. Reporting rows-affected would mean the client
	// could read a harmless retry as a failure.
	if err := json.NewEncoder(w).Encode(map[string]any{"acked": len(body.IDs)}); err != nil {
		slog.Warn("feedback reader: write ack response", "error", err)
	}
}

func (a *FeedbackReaderAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodDelete:
	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodDelete)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// One gate for both verbs (bd med-rbl.3): the ack is the same capability as
	// the read, so it goes through the same token check rather than a second
	// auth path that could drift out of step with it.
	if !a.authorized(w, r) {
		return
	}
	if r.Method == http.MethodDelete {
		a.ack(w, r)
		return
	}

	items, err := a.store.ListRecentFeedback(r.Context(), feedbackQueueLimit)
	if err != nil {
		slog.Error("feedback reader: list queue", "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]feedbackQueueItem, 0, len(items))
	for _, it := range items {
		out = append(out, feedbackQueueItem{
			ID:            it.ID,
			Kind:          it.Kind,
			AppVersion:    it.AppVersion,
			CreatedAt:     it.CreatedAt.UTC().Format(time.RFC3339),
			CiphertextB64: base64.StdEncoding.EncodeToString(it.Ciphertext),
		})
	}
	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{"items": out}); err != nil {
		slog.Warn("feedback reader: write response", "error", err)
	}
}
