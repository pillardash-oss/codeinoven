package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// handleListMessages serves GET /v1/threads/{id}/messages: oldest first.
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
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

	// Confirm the thread exists so a stale id answers 404 instead of an empty page.
	if _, err := s.store.ThreadByID(r.Context(), authCtx.Store.SchemaName, threadID); err != nil {
		writeError(w, s.log, err)
		return
	}

	limit, err := queryLimit(r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	const sort = "sequence"
	var cursor *store.Cursor
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		decoded, err := decodeCursor(raw, sort)
		if err != nil {
			writeError(w, s.log, badRequest("cursor is not valid for this listing"))
			return
		}
		cursor = &decoded
	}

	messages, more, err := s.store.ListMessages(
		r.Context(), authCtx.Store.SchemaName, threadID,
		store.MessageFilter{Limit: limit, Cursor: cursor},
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	next := ""
	if more && len(messages) > 0 {
		last := messages[len(messages)-1]
		next = encodeCursor(store.Cursor{Sort: sort, Number: int64(last.Seq), ID: last.ID})
	}
	writeList(w, http.StatusOK, messages, next)
}
