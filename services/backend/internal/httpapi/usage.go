package httpapi

import (
	"net/http"
	"strings"
)

// handleThreadUsage serves GET /v1/threads/{id}/usage: the context meter.
//
// Every number is derived from stored token columns, so a thread whose runs
// reported nothing reads as zero rather than as an estimate.
func (s *Server) handleThreadUsage(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeError(w, s.log, badRequest("thread id is required"))
		return
	}

	usage, err := s.store.ThreadUsage(r.Context(), authCtx.Store.SchemaName, threadID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, usage)
}

// handleResetThreadUsage serves POST /v1/threads/{id}/usage/reset.
//
// A reset moves the meter's start to now; it deletes no message, so the transcript
// the person is looking at stays exactly as it was.
func (s *Server) handleResetThreadUsage(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	threadID := strings.TrimSpace(r.PathValue("id"))
	if threadID == "" {
		writeError(w, s.log, badRequest("thread id is required"))
		return
	}

	usage, err := s.store.ResetThreadUsage(r.Context(), authCtx.Store.SchemaName, threadID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("thread usage reset", "thread", threadID, "user", authCtx.User.ID)
	writeData(w, http.StatusOK, usage)
}
