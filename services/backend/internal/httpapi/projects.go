package httpapi

import (
	"net/http"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxProjectNameBytes is the longest name a project may be created with: it is
// drawn on one strip of the phone's project list, so a longer one is a mistake.
const maxProjectNameBytes = 120

// maxProjectPathBytes bounds the path a project states, matching the desktop's
// own column. The phone may leave it empty.
const maxProjectPathBytes = 1024

// createProjectRequest is the POST /v1/projects body.
type createProjectRequest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleListProjects serves GET /v1/projects.
//
// Query parameters: sort=activity|name|created, q, limit, cursor.
func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	sort := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sort")))
	switch sort {
	case "":
		sort = store.ProjectSortActivity
	case store.ProjectSortActivity, store.ProjectSortName, store.ProjectSortCreated:
	default:
		writeError(w, s.log, badRequest("sort must be activity, name or created"))
		return
	}

	limit, err := queryLimit(r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	var cursor *store.Cursor
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		decoded, err := decodeCursor(raw, sort)
		if err != nil {
			writeError(w, s.log, badRequest("cursor is not valid for this sort"))
			return
		}
		cursor = &decoded
	}

	projects, more, err := s.store.ListProjects(r.Context(), authCtx.Store.SchemaName, store.ProjectFilter{
		Sort:   sort,
		Query:  r.URL.Query().Get("q"),
		Limit:  limit,
		Cursor: cursor,
	})
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	next := ""
	if more && len(projects) > 0 {
		last := projects[len(projects)-1]
		cursorKey := store.Cursor{Sort: sort, ID: last.ID}
		switch sort {
		case store.ProjectSortName:
			cursorKey.Name = strings.ToLower(last.Name)
		case store.ProjectSortCreated:
			cursorKey.Number = last.CreatedMillis
		default:
			cursorKey.Number = last.ActivityMillis
		}
		next = encodeCursor(cursorKey)
	}
	writeList(w, http.StatusOK, projects, next)
}

// handleCreateProject serves POST /v1/projects.
//
// The phone may start a project on its own, so the name is the only required
// field. A path is stored when the caller knows it and stays empty until the
// desktop's Oven reports the checkout it works in.
func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}

	var req createProjectRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, s.log, badRequest("name is required"))
		return
	}
	if len(name) > maxProjectNameBytes {
		writeError(w, s.log, badRequest("name must be at most 120 bytes"))
		return
	}
	path := strings.TrimSpace(req.Path)
	if len(path) > maxProjectPathBytes {
		writeError(w, s.log, badRequest("path must be at most 1024 bytes"))
		return
	}

	project, err := s.store.CreateProject(
		r.Context(), authCtx.Store.SchemaName,
		auth.NewID(auth.PrefixProject), name, path,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusCreated, project)
}

// handleGetProject serves GET /v1/projects/{id}.
func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	projectID := strings.TrimSpace(r.PathValue("id"))
	if projectID == "" {
		writeError(w, s.log, badRequest("project id is required"))
		return
	}

	project, err := s.store.ProjectByID(r.Context(), authCtx.Store.SchemaName, projectID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, project)
}
