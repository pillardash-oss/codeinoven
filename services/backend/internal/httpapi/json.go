package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// maxBodyBytes is the hard request body limit: 1 MiB.
const maxBodyBytes = 1 << 20

// Codes from services/README.md. Each has exactly one status.
const (
	codeBadRequest         = "bad_request"
	codeUnauthorized       = "unauthorized"
	codeForbidden          = "forbidden"
	codeNotFound           = "not_found"
	codeConflict           = "conflict"
	codeInvalidCredentials = "invalid_credentials"
	codeEmailNotVerified   = "email_not_verified"
	codeRateLimited        = "rate_limited"
	codeUnsupported        = "unsupported"
	codeInternal           = "internal"
)

// codeStatus is the single mapping from an error code to an HTTP status.
var codeStatus = map[string]int{
	codeBadRequest:         http.StatusBadRequest,
	codeUnauthorized:       http.StatusUnauthorized,
	codeForbidden:          http.StatusForbidden,
	codeNotFound:           http.StatusNotFound,
	codeConflict:           http.StatusConflict,
	codeInvalidCredentials: http.StatusUnauthorized,
	codeEmailNotVerified:   http.StatusForbidden,
	codeRateLimited:        http.StatusTooManyRequests,
	codeUnsupported:        http.StatusNotImplemented,
	codeInternal:           http.StatusInternalServerError,
}

func statusForCode(code string) int {
	if status, ok := codeStatus[code]; ok {
		return status
	}
	return http.StatusInternalServerError
}

// APIError is a failure that already knows its code and status.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	if e.Details != "" {
		return e.Code + ": " + e.Message + " (" + e.Details + ")"
	}
	return e.Code + ": " + e.Message
}

// detail is the body of a failure.
type detail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

// errorBody is the one failure envelope.
type errorBody struct {
	Error detail `json:"error"`
}

// newAPIError builds an error, deriving the status from the code.
func newAPIError(code, message, details string) *APIError {
	return &APIError{Status: statusForCode(code), Code: code, Message: message, Details: details}
}

func badRequest(details string) *APIError {
	return newAPIError(codeBadRequest, "The request is not valid.", details)
}

func unauthorized() *APIError {
	return newAPIError(codeUnauthorized, "Sign in to continue.", "")
}

func forbidden(message string) *APIError {
	return newAPIError(codeForbidden, message, "")
}

func notFound(message string) *APIError {
	return newAPIError(codeNotFound, message, "")
}

func conflict(message string) *APIError {
	return newAPIError(codeConflict, message, "")
}

func invalidCredentials() *APIError {
	return newAPIError(codeInvalidCredentials, "Email or password is incorrect.", "")
}

func emailNotVerified() *APIError {
	return newAPIError(codeEmailNotVerified, "Verify your email address to continue.", "")
}

func rateLimited() *APIError {
	return newAPIError(codeRateLimited, "Too many attempts. Try again later.", "")
}

func unsupported(message string) *APIError {
	return newAPIError(codeUnsupported, message, "")
}

func internalError() *APIError {
	return newAPIError(codeInternal, "Something went wrong.", "")
}

// errorResponse maps any error to the status and body pair.
//
// APIErrors are used as they are; store sentinels get the status their meaning
// implies; anything else becomes an opaque internal error so a driver message
// never reaches a client.
func errorResponse(err error) (int, errorBody) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status, errorBody{Error: detail{
			Code:    apiErr.Code,
			Message: apiErr.Message,
			Details: apiErr.Details,
		}}
	}

	switch {
	case errors.Is(err, store.ErrNotFound):
		return statusForCode(codeNotFound), errorBody{Error: detail{
			Code: codeNotFound, Message: "The resource does not exist.",
		}}
	case errors.Is(err, store.ErrTokenInvalid):
		return statusForCode(codeBadRequest), errorBody{Error: detail{
			Code:    codeBadRequest,
			Message: "The link is invalid or has expired.",
		}}
	case errors.Is(err, store.ErrEmailTaken):
		return statusForCode(codeConflict), errorBody{Error: detail{
			Code: codeConflict, Message: "An account with this email already exists.",
		}}
	}

	return statusForCode(codeInternal), errorBody{Error: detail{
		Code: codeInternal, Message: "Something went wrong.",
	}}
}

// writeJSON writes a body with the given status.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"internal","message":"Something went wrong."}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// dataEnvelope is the success envelope.
type dataEnvelope struct {
	Data any `json:"data"`
}

// listEnvelope is the paginated envelope. nextCursor is omitted on the last page.
type listEnvelope struct {
	Data       any    `json:"data"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// writeData writes {"data": payload}.
func writeData(w http.ResponseWriter, status int, payload any) {
	writeJSON(w, status, dataEnvelope{Data: payload})
}

// writeList writes {"data": [...], "nextCursor": "..."} and omits an empty cursor.
func writeList(w http.ResponseWriter, status int, items any, nextCursor string) {
	writeJSON(w, status, listEnvelope{Data: items, NextCursor: nextCursor})
}

// writeError writes the failure envelope, logging anything that is not an
// expected API error.
func writeError(w http.ResponseWriter, logger *slog.Logger, err error) {
	status, body := errorResponse(err)
	if status >= http.StatusInternalServerError {
		logger.Error("request failed", "status", status, "error", err.Error())
	}
	writeJSON(w, status, body)
}

// decodeJSON reads exactly one JSON object into dst, rejecting unknown fields and
// bodies larger than 1 MiB.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return badRequest("request body must be at most 1 MiB")
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
