package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

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
