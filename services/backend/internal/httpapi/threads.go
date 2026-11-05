package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/models"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxThreadTitleBytes is the longest title the phone may start a thread with.
const maxThreadTitleBytes = 200

// maxAccountRunes bounds the account label a thread states, matching the Oven
// name bound: the label is drawn in one chip, so a longer one is a mistake.
const maxAccountRunes = 120

// optional is one JSON value a request may omit, null, or set.
//
// The decoder calls UnmarshalJSON only for a key that is present, so Set answers
// "did the caller say anything at all" and Value is what it said (nil for an
// explicit null). The composer contract needs that distinction: PATCH leaves an
// omitted field alone and clears a null one.
type optional[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON records that the key was present before decoding its value.
func (o *optional[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(bytes.TrimSpace(data)) == "null" {
		o.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

// field converts a decoded optional into the store's patch field.
func field[T any](value optional[T]) store.Field[T] {
	return store.Field[T]{Set: value.Set, Value: value.Value}
}

// createThreadRequest is the POST /v1/threads body.
type createThreadRequest struct {
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
}

// patchThreadRequest is the PATCH /v1/threads/{id} body: the composer's choices.
// Every field is optional, and an omitted field keeps the thread's current value.
type patchThreadRequest struct {
	Model      optional[string] `json:"model"`
	Thinking   optional[string] `json:"thinking"`
	Permission optional[string] `json:"permission"`
	Account    optional[string] `json:"account"`
	OvenID     optional[string] `json:"ovenId"`
	FileSystem optional[bool]   `json:"fileSystem"`
}

// patch returns the request as the store's patch shape.
func (req patchThreadRequest) patch() store.ThreadPatch {
	return store.ThreadPatch{
		Model:      field(req.Model),
		Thinking:   field(req.Thinking),
		Permission: field(req.Permission),
		Account:    field(req.Account),
		OvenID:     field(req.OvenID),
		FileSystem: field(req.FileSystem),
	}
}

// handleListThreads serves GET /v1/threads.
//
// Query parameters: project, state, unread=true, q, limit, cursor. `state` is
// either one of the nine statuses or one of the groups the contract's status
// counts use (attention, spec, working, done, failed).
func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	statuses, err := parseStateFilter(r.URL.Query().Get("state"))
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	unread, err := queryBool(r, "unread")
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	limit, err := queryLimit(r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	const sort = "activity"
	var cursor *store.Cursor
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		decoded, err := decodeCursor(raw, sort)
		if err != nil {
			writeError(w, s.log, badRequest("cursor is not valid for this listing"))
			return
		}
		cursor = &decoded
	}

	threads, more, err := s.store.ListThreads(r.Context(), authCtx.Store.SchemaName, store.ThreadFilter{
		ProjectID: strings.TrimSpace(r.URL.Query().Get("project")),
		Statuses:  statuses,
		Unread:    unread,
		Query:     r.URL.Query().Get("q"),
		Limit:     limit,
		Cursor:    cursor,
	})
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	next := ""
	if more && len(threads) > 0 {
		last := threads[len(threads)-1]
		next = encodeCursor(store.Cursor{
			Sort:   sort,
			Number: last.ActivityMillis,
			Flag:   last.Pinned,
			ID:     last.ID,
		})
	}
	writeList(w, http.StatusOK, threads, next)
}

// parseStateFilter accepts a status name or a status group.
func parseStateFilter(raw string) ([]string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return nil, nil
	}
	if group, ok := store.StatusGroups[value]; ok {
		return group, nil
	}
	for _, status := range store.ThreadStatuses {
		if status == value {
			return []string{value}, nil
		}
	}
	return nil, badRequest(
		"state must be one of attention, spec, working, done, failed, " + strings.Join(store.ThreadStatuses, ", "),
	)
}

// handleGetThread serves GET /v1/threads/{id}.
// handleCreateThread serves POST /v1/threads.
//
// A phone starts a thread in a project it is already looking at, so the request
// is the project and a title and nothing else: the owner of this service is the
// desktop that will pick the work up.
func (s *Server) handleCreateThread(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	var req createThreadRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	projectID := strings.TrimSpace(req.ProjectID)
	if projectID == "" {
		writeError(w, s.log, badRequest("projectId is required"))
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeError(w, s.log, badRequest("title is required"))
		return
	}
	if len(title) > maxThreadTitleBytes {
		writeError(w, s.log, badRequest("title must be at most 200 bytes"))
		return
	}

	if _, err := s.store.ProjectByID(r.Context(), authCtx.Store.SchemaName, projectID); err != nil {
		writeError(w, s.log, err)
		return
	}

	thread, err := s.store.CreateThread(
		r.Context(), authCtx.Store.SchemaName,
		auth.NewID(auth.PrefixThread), projectID, title,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusCreated, thread)
}

func (s *Server) handleGetThread(w http.ResponseWriter, r *http.Request) {
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

	thread, err := s.store.ThreadByID(r.Context(), authCtx.Store.SchemaName, threadID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, thread)
}

// handlePatchThread serves PATCH /v1/threads/{id}: the composer's choices.
//
// The body is a patch, not a whole thread: a field the caller omits keeps the
// column it names, and an explicit null clears it. That is what lets the phone
// send only the chip the person changed.
func (s *Server) handlePatchThread(w http.ResponseWriter, r *http.Request) {
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

	var req patchThreadRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}

	patch := req.patch()
	if err := s.validateChoices(r.Context(), authCtx, patch); err != nil {
		writeError(w, s.log, err)
		return
	}

	thread, err := s.store.UpdateThreadComposer(
		r.Context(), authCtx.Store.SchemaName, threadID, patch,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, thread)
}

// validateChoices checks the composer's choices a caller sent.
//
// It is shared by PATCH and by the prompt endpoint so both reject the same values
// in the same words, and an Oven id is checked against this caller's own Ovens
// rather than accepted as a free string.
func (s *Server) validateChoices(
	ctx context.Context, authCtx store.Auth, patch store.ThreadPatch,
) error {
	if patch.Model.Set && patch.Model.Value != nil && !models.Has(*patch.Model.Value) {
		return badRequest("model must be an id GET /v1/models lists")
	}
	if patch.Thinking.Set && patch.Thinking.Value != nil &&
		!containsString(store.ThinkingLevels, *patch.Thinking.Value) {
		return badRequest("thinking must be one of " + strings.Join(store.ThinkingLevels, ", "))
	}
	if patch.Permission.Set && patch.Permission.Value != nil &&
		!containsString(store.PermissionLevels, *patch.Permission.Value) {
		return badRequest("permission must be one of " + strings.Join(store.PermissionLevels, ", "))
	}
	if patch.Account.Set && patch.Account.Value != nil &&
		utf8.RuneCountInString(*patch.Account.Value) > maxAccountRunes {
		return badRequest("account must be at most 120 characters")
	}
	if patch.OvenID.Set && patch.OvenID.Value != nil {
		ovenID := strings.TrimSpace(*patch.OvenID.Value)
		if ovenID == "" {
			return badRequest("ovenId must name one of your Ovens, or be null")
		}
		owned, err := s.store.OvenOwnedBy(ctx, authCtx.User.ID, ovenID)
		if err != nil {
			return err
		}
		if !owned {
			return badRequest("ovenId must name one of your Ovens, or be null")
		}
	}
	return nil
}

// containsString reports whether values holds one exact string.
func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
