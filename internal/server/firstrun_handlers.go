package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

// handleFirstRunComplete handles POST /api/firstrun/complete. It is the
// dismissal hook for the mobile first-run overlay (Phase 2c): a fresh DB
// surfaces needs_first_run=true on /api/bootstrap, the user walks (or skips)
// the welcome/permissions/integrations/done screens, and the final step posts
// here to flip first_run_complete to 1 so the overlay never re-mounts.
//
// Idempotent: calling this repeatedly is safe — SetFirstRunComplete is a plain
// UPDATE that converges. The plan stub also called for lazy provisioning of a
// users row, but this schema has no users table (user_id columns are bare
// integers with no enforced FK), so user provisioning is intentionally a no-op
// here. If a users table is ever introduced, hook the INSERT OR IGNORE in
// front of the settings write.
func (s *Server) handleFirstRunComplete(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	if err := s.settings.SetFirstRunComplete(ctx, true); err != nil {
		slog.Error("handleFirstRunComplete: SetFirstRunComplete failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
