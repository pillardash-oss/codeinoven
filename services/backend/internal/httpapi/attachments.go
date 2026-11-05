package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxAttachmentBytes is the most a decoded attachment may weigh: 4 MiB, which is
// a phone photo scaled by the client and nothing more.
const maxAttachmentBytes = 4 << 20

// attachmentRequest is the POST /v1/threads/{id}/attachments body.
//
// The bytes travel as base64 inside JSON, because that is what a WebView can send
// without a multipart encoder: base64 costs a third more bytes, so 4 MiB decoded
// is about 5.6 MiB on the wire and the upload route's body limit is 6 MiB.
type attachmentRequest struct {
	Name       string `json:"name"`
	Mime       string `json:"mime"`
	DataBase64 string `json:"dataBase64"`
}

// decodeAttachmentRequest reads the upload body.
//
// It is not decodeJSON because that one caps the body at 1 MiB, a limit a photo
// cannot fit in. The middleware already raised this route's limit; this is the
// matching read.
func decodeAttachmentRequest(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return badRequest("request body must be at most 6 MiB")
		}
		if errors.Is(err, io.EOF) {
			return badRequest("request body is required and must be a JSON object")
		}
		return badRequest(err.Error())
	}
	if decoder.More() {
		return badRequest("request body must contain a single JSON object")
	}
	return nil
}

// handleCreateAttachment serves POST /v1/threads/{id}/attachments.
//
// The file is stored against the thread, unattached, and answers 201 with the row
// so the composer can show it while the message is still being typed. Sending the
// prompt with its id binds it.
func (s *Server) handleCreateAttachment(w http.ResponseWriter, r *http.Request) {
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

	var req attachmentRequest
	if err := decodeAttachmentRequest(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, s.log, badRequest("name is required"))
		return
	}
	mime := strings.TrimSpace(req.Mime)
	if mime == "" {
		writeError(w, s.log, badRequest("mime is required"))
		return
	}

	decoded, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		writeError(w, s.log, badRequest("dataBase64 must be standard base64"))
		return
	}
	if len(decoded) > maxAttachmentBytes {
		writeError(w, s.log, badRequest("attachment must be at most 4 MiB once decoded"))
		return
	}

	attachment, err := s.store.CreateAttachment(
		r.Context(), authCtx.Store.SchemaName, store.AttachmentInput{
			ID:       auth.NewID(auth.PrefixAttachment),
			ThreadID: threadID,
			Name:     name,
			Mime:     mime,
			Bytes:    decoded,
		},
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("attachment stored", "attachment", attachment.ID, "thread", threadID,
		"bytes", attachment.Size, "user", authCtx.User.ID)
	writeData(w, http.StatusCreated, attachment)
}

// handleGetAttachment serves GET /v1/attachments/{id}: the bytes themselves.
//
// This is the one route that does not answer in the JSON envelope, because a file
// is not a payload: the response is the file with its own Content-Type and
// Content-Length, which is what an <img> or a download needs.
func (s *Server) handleGetAttachment(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	attachmentID := strings.TrimSpace(r.PathValue("id"))
	if attachmentID == "" {
		writeError(w, s.log, badRequest("attachment id is required"))
		return
	}

	attachment, bytes, err := s.store.AttachmentContent(
		r.Context(), authCtx.Store.SchemaName, attachmentID,
	)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	w.Header().Set("Content-Type", attachment.Mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(bytes)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytes)
}

// handleDeleteAttachment serves DELETE /v1/attachments/{id}.
//
// 204 while no prompt carries the file. Once a prompt does, the message may be on
// its way to an Oven, so the answer is 409 and the file stays.
func (s *Server) handleDeleteAttachment(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	attachmentID := strings.TrimSpace(r.PathValue("id"))
	if attachmentID == "" {
		writeError(w, s.log, badRequest("attachment id is required"))
		return
	}

	if err := s.store.DeleteAttachment(
		r.Context(), authCtx.Store.SchemaName, attachmentID,
	); err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("attachment deleted", "attachment", attachmentID, "user", authCtx.User.ID)
	w.WriteHeader(http.StatusNoContent)
}
