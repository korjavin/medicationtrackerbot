package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// handleFirstRunComplete handles POST /api/firstrun/complete. It is the
// dismissal hook for the first-run overlay: a fresh DB
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
	// Demo mode resolves every visitor to the same singleton user, so any
	// anonymous visitor could flip first_run_complete and suppress the
	// overlay for every other visitor. The seeder sets the flag to true so
	// the overlay never fires in demo deployments anyway, but match the
	// integrations handler's defense-in-depth gate (settings_integrations_handlers.go)
	// so demo state is not mutable from the public Internet.
	if s.demoMode {
		http.Error(w, "firstrun completion is disabled in demo mode", http.StatusForbidden)
		return
	}
	ctx := r.Context()
	if err := s.settings.SetFirstRunComplete(ctx, true); err != nil {
		slog.Error("handleFirstRunComplete: SetFirstRunComplete failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
