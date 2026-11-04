package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxThreadTitleBytes is the longest title the phone may start a thread with.
const maxThreadTitleBytes = 200

// createThreadRequest is the POST /v1/threads body.
type createThreadRequest struct {
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
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
