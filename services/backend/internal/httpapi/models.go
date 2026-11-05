package httpapi

import (
	"net/http"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/models"
)

// handleListModels serves GET /v1/models: the catalog the picker draws, plus the
// model ids this account used most recently.
//
// The recent list is derived from the user's own threads in the last thirty days,
// filtered by the catalog in internal/models, so a thread that named a model the
// service has since dropped contributes nothing instead of an id the client could
// not draw.
func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	recent, err := s.store.RecentModels(r.Context(), authCtx.Store.SchemaName)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	writeData(w, http.StatusOK, models.Catalog{
		Items:  models.All(),
		Recent: models.Recent(recent),
	})
}
