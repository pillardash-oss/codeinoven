package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// handleStoreStatus serves GET /v1/store/status: how far this user's schema has
// been migrated compared with what this binary requires.
func (s *Server) handleStoreStatus(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	if authCtx.Store == nil {
		writeError(w, s.log, internalError())
		return
	}

	status, err := s.store.StoreStatus(r.Context(), *authCtx.Store)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, status)
}

// mustJSON marshals a value that was just decoded from JSON, so it cannot fail
// on anything the decoder accepted.
func mustJSON(value any) store.JSON {
	encoded, err := json.Marshal(value)
	if err != nil {
		return store.JSON("{}")
	}
	return encoded
}
