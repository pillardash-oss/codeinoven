package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// mePayload is GET /v1/me: the user with their store's status.
type mePayload struct {
	store.User
	Store store.StoreStatus `json:"store"`
}

// meFor builds the payload for a signed-in user.
func (s *Server) meFor(r *http.Request, authCtx store.Auth) (mePayload, error) {
	if authCtx.Store == nil {
		return mePayload{}, internalError()
	}
	status, err := s.store.StoreStatus(r.Context(), *authCtx.Store)
	if err != nil {
		return mePayload{}, err
	}
	return mePayload{User: authCtx.User, Store: status}, nil
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	payload, err := s.meFor(r, authCtx)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, payload)
}

// updateMeRequest is the PATCH /v1/me body.
type updateMeRequest struct {
	Name *string `json:"name"`
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	var req updateMeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	if req.Name == nil {
		writeError(w, s.log, badRequest("name is required (send null to clear it)"))
		return
	}
	name, err := parseOptionalName(*req.Name)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	user, err := s.store.SetUserName(r.Context(), authCtx.User.ID, name)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	authCtx.User = user

	payload, err := s.meFor(r, authCtx)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, payload)
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	devices, err := s.store.ListDevices(r.Context(), authCtx.User.ID, authCtx.Session.DeviceID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, devices)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	deviceID := strings.TrimSpace(r.PathValue("id"))
	if deviceID == "" {
		writeError(w, s.log, badRequest("device id is required"))
		return
	}
	if err := s.store.RevokeDevice(r.Context(), authCtx.User.ID, deviceID); err != nil {
		writeError(w, s.log, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
