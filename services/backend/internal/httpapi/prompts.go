package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxPromptBytes bounds a prompt body well under the 1 MiB request limit.
const maxPromptBytes = 100_000

// maxAttachmentIDBytes bounds one attachment id, like every other id here.
const maxAttachmentIDBytes = 200

// createPromptRequest is the POST /v1/threads/{id}/prompts body.
//
// The composer fields are optional: what the caller omits is read from the thread
// row, so the stored prompt always states the full choice the desktop will run.
type createPromptRequest struct {
	Body          string           `json:"body"`
	ClientID      string           `json:"clientId"`
	AttachmentIDs []string         `json:"attachmentIds"`
	Model         optional[string] `json:"model"`
	Thinking      optional[string] `json:"thinking"`
	Permission    optional[string] `json:"permission"`
	Account       optional[string] `json:"account"`
	OvenID        optional[string] `json:"ovenId"`
	FileSystem    optional[bool]   `json:"fileSystem"`
}

// patch returns the composer fields of the request as the store's patch shape.
func (req createPromptRequest) patch() store.ThreadPatch {
	return store.ThreadPatch{
		Model:      field(req.Model),
		Thinking:   field(req.Thinking),
		Permission: field(req.Permission),
		Account:    field(req.Account),
		OvenID:     field(req.OvenID),
		FileSystem: field(req.FileSystem),
	}
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

	attachmentIDs := make([]string, 0, len(req.AttachmentIDs))
	for _, raw := range req.AttachmentIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			writeError(w, s.log, badRequest("attachmentIds must not contain an empty id"))
			return
		}
		if len(id) > maxAttachmentIDBytes {
			writeError(w, s.log, badRequest("attachmentIds must be at most 200 characters each"))
			return
		}
		attachmentIDs = append(attachmentIDs, id)
	}

	patch := req.patch()
	if err := s.validateChoices(r.Context(), authCtx, patch); err != nil {
		writeError(w, s.log, err)
		return
	}

	prompt, created, err := s.store.EnqueuePrompt(
		r.Context(), authCtx.Store.SchemaName, store.PromptInput{
			ID:            auth.NewID(auth.PrefixPrompt),
			ThreadID:      threadID,
			Body:          body,
			ClientID:      clientID,
			AttachmentIDs: attachmentIDs,
			Choices:       patch,
		},
	)
	if err != nil {
		// An attachment id that is unknown, another thread's, or already carried by
		// a prompt makes the request wrong, so it is a 400 rather than a conflict.
		if errors.Is(err, store.ErrAttachmentInvalid) {
			writeError(w, s.log, badRequest(
				"attachmentIds must be this thread's unattached attachments"))
			return
		}
		writeError(w, s.log, err)
		return
	}
	if created {
		s.log.Info("prompt queued", "prompt", prompt.ID, "thread", threadID,
			"attachments", len(prompt.Attachments), "user", authCtx.User.ID)
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
