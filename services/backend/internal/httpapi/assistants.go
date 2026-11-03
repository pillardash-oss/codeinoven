package httpapi

import (
	"net/http"
)

// handleListAssistants serves GET /v1/assistants.
//
// A phone lists assistants read-only: the list is short, it is not paginated, and
// every assistant carries the icon the desktop stored for it.
func (s *Server) handleListAssistants(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	assistants, err := s.store.ListAssistants(r.Context(), authCtx.Store.SchemaName)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, assistants)
}
