package server

import "net/http"

func (s *Server) handleExportVault(w http.ResponseWriter, r *http.Request) {
    // Stub for now to make tests pass until Task 2 is fully implemented
    w.WriteHeader(http.StatusNotImplemented)
}
