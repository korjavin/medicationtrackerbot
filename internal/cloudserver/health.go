package cloudserver

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"time"
)

// readyzTimeout bounds the database probe. A readiness check that can hang is
// worse than none: the orchestrator waits on it instead of restarting.
const readyzTimeout = 2 * time.Second

// readyDB is the one method ReadyzHandler needs, so tests can hand it a closed
// database without standing up the whole store.
type readyDB interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type readyResponse struct {
	Status  string `json:"status"`
	BuildID string `json:"build,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ReadyzHandler answers whether this instance can actually serve: it reads the
// database, rather than asserting it is alive (med-d5t.7).
//
// /healthz stays a liveness probe that returns "ok" unconditionally, so the
// container orchestrator's restart behavior does not change. But that made a
// cloud.db which was locked, corrupt, or on a full disk report perfectly
// healthy while every request failed.
//
// The probe is a real read of a real table, not a Ping. A Ping succeeds against
// a handle whose file has been deleted or whose schema never migrated; counting
// rows in `accounts` touches the B-tree and fails when the database is
// genuinely unusable. The row count itself is deliberately NOT reported — this
// endpoint is unauthenticated, and how many friends are on the box is not
// something a passer-by needs to learn.
func ReadyzHandler(db readyDB, buildID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyzTimeout)
		defer cancel()

		var accounts int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM accounts`).Scan(&accounts); err != nil {
			// Logged, not returned: the error text can name the filesystem path.
			slog.Error("readyz: database unreadable", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, readyResponse{Status: "unready", BuildID: buildID, Error: "database unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, readyResponse{Status: "ready", BuildID: buildID})
	}
}
