package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
)

// maxPromptBytes bounds a prompt body well under the 1 MiB request limit.
const maxPromptBytes = 100_000

// createPromptRequest is the POST /v1/threads/{id}/prompts body.
type createPromptRequest struct {
	Body     string `json:"body"`
	ClientID string `json:"clientId"`
}

// handleCreatePrompt queues a prompt for an Oven and answers 202.
//
// A client that supplies clientId gets idempotency: sending the same prompt
// twice returns the same prompt row instead of queueing it twice.
func (s *Server) handleCreatePrompt(w http.ResponseWriter, r *http.Request) {
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

	var req createPromptRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeError(w, s.log, badRequest("body is required"))
		return
	}
	if len(body) > maxPromptBytes {
		writeError(w, s.log, badRequest("body must be at most 100000 bytes"))
		return
	}
	clientID := strings.TrimSpace(req.ClientID)
	if len(clientID) > 200 {
		writeError(w, s.log, badRequest("clientId must be at most 200 characters"))
		return
	}

	prompt, created, err := s.store.EnqueuePrompt(
		r.Context(), authCtx.Store.SchemaName, auth.NewID(auth.PrefixPrompt), threadID, body, clientID,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	if created {
		s.log.Info("prompt queued", "prompt", prompt.ID, "thread", threadID, "user", authCtx.User.ID)
	}
	writeData(w, http.StatusAccepted, prompt)
}

// handleGetPrompt serves GET /v1/prompts/{id}.
func (s *Server) handleGetPrompt(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	promptID := strings.TrimSpace(r.PathValue("id"))
	if promptID == "" {
		writeError(w, s.log, badRequest("prompt id is required"))
		return
	}

	prompt, err := s.store.PromptByID(r.Context(), authCtx.Store.SchemaName, promptID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, prompt)
}

// handleDeletePrompt serves DELETE /v1/prompts/{id}.
//
// Only a prompt the Oven has not claimed can be taken back, which is what lets
// the phone offer "delete" on a held message at all: it answers 409 once the
// prompt has moved on, and 404 for one that never existed.
func (s *Server) handleDeletePrompt(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	promptID := strings.TrimSpace(r.PathValue("id"))
	if promptID == "" {
		writeError(w, s.log, badRequest("prompt id is required"))
		return
	}

	if err := s.store.DeletePrompt(r.Context(), authCtx.Store.SchemaName, promptID); err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("prompt deleted", "prompt", promptID, "user", authCtx.User.ID)
	w.WriteHeader(http.StatusNoContent)
}

// handleSteerPrompt serves POST /v1/prompts/{id}/steer.
//
// Steering is how a held message stops waiting its turn: the Oven takes it next,
// ahead of the rest of the queue. It is the same prompt, so the phone keeps its
// row and only its state changes.
func (s *Server) handleSteerPrompt(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	promptID := strings.TrimSpace(r.PathValue("id"))
	if promptID == "" {
		writeError(w, s.log, badRequest("prompt id is required"))
		return
	}

	prompt, err := s.store.SteerPrompt(r.Context(), authCtx.Store.SchemaName, promptID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("prompt steered", "prompt", prompt.ID, "thread", prompt.ThreadID, "user", authCtx.User.ID)
	writeData(w, http.StatusOK, prompt)
}
