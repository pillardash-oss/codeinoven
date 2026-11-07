package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// heartbeatRequest is the POST /v1/ovens/heartbeat body.
type heartbeatRequest struct {
	Name        string         `json:"name"`
	Fingerprint string         `json:"fingerprint"`
	Descriptor  map[string]any `json:"descriptor"`
}

// handleOvenHeartbeat upserts the caller's Oven and answers with the row, so the
// client learns the server id it should keep.
func (s *Server) handleOvenHeartbeat(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	var req heartbeatRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, s.log, badRequest("name is required"))
		return
	}
	if len([]rune(name)) > 120 {
		writeError(w, s.log, badRequest("name must be at most 120 characters"))
		return
	}
	fingerprint := strings.TrimSpace(req.Fingerprint)
	if fingerprint == "" {
		writeError(w, s.log, badRequest("fingerprint is required"))
		return
	}
	if len(fingerprint) > 200 {
		writeError(w, s.log, badRequest("fingerprint must be at most 200 characters"))
		return
	}

	var descriptor store.JSON
	if len(req.Descriptor) > 0 {
		encoded := mustJSON(req.Descriptor)
		if len(encoded) > 16*1024 {
			writeError(w, s.log, badRequest("descriptor must be at most 16 KiB"))
			return
		}
		descriptor = encoded
	}

	oven, err := s.store.UpsertOven(
		r.Context(), auth.NewID(auth.PrefixOven), authCtx.User.ID, name, fingerprint, descriptor,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, oven)
}

// handleListOvens serves GET /v1/ovens.
func (s *Server) handleListOvens(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	ovens, err := s.store.ListOvens(r.Context(), authCtx.User.ID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, ovens)
}
