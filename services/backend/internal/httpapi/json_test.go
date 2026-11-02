package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

func TestStatusForEveryContractCode(t *testing.T) {
	t.Parallel()

	want := map[string]int{
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

	for code, status := range want {
		if got := statusForCode(code); got != status {
			t.Fatalf("statusForCode(%q) = %d, want %d", code, got, status)
		}
	}

	if got := statusForCode("not_a_real_code"); got != http.StatusInternalServerError {
		t.Fatalf("unknown codes must map to 500, got %d", got)
	}
}

func TestErrorResponsePreservesAPIErrors(t *testing.T) {
	t.Parallel()

	status, body := errorResponse(badRequest("email is required"))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	if body.Error.Code != codeBadRequest {
		t.Fatalf("code = %q, want %q", body.Error.Code, codeBadRequest)
	}
	if body.Error.Details != "email is required" {
		t.Fatalf("details = %q, want the helpful hint", body.Error.Details)
	}

	status, body = errorResponse(unsupported("GitHub sign-in is not configured on this server."))
	if status != http.StatusNotImplemented || body.Error.Code != codeUnsupported {
		t.Fatalf("unsupported mapped to %d/%q", status, body.Error.Code)
	}

	status, body = errorResponse(rateLimited())
	if status != http.StatusTooManyRequests || body.Error.Code != codeRateLimited {
		t.Fatalf("rate limited mapped to %d/%q", status, body.Error.Code)
	}

	status, body = errorResponse(invalidCredentials())
	if status != http.StatusUnauthorized || body.Error.Code != codeInvalidCredentials {
		t.Fatalf("invalid credentials mapped to %d/%q", status, body.Error.Code)
	}

	status, body = errorResponse(emailNotVerified())
	if status != http.StatusForbidden || body.Error.Code != codeEmailNotVerified {
		t.Fatalf("email not verified mapped to %d/%q", status, body.Error.Code)
	}
}

func TestErrorResponseMapsStoreSentinels(t *testing.T) {
	t.Parallel()

	cases := []struct {
		err        error
		wantStatus int
		wantCode   string
	}{
		{store.ErrNotFound, http.StatusNotFound, codeNotFound},
		{store.ErrTokenInvalid, http.StatusBadRequest, codeBadRequest},
		{store.ErrEmailTaken, http.StatusConflict, codeConflict},
		{fmt.Errorf("wrapped: %w", store.ErrNotFound), http.StatusNotFound, codeNotFound},
	}

	for _, test := range cases {
		status, body := errorResponse(test.err)
		if status != test.wantStatus || body.Error.Code != test.wantCode {
			t.Fatalf("%v mapped to %d/%q, want %d/%q",
				test.err, status, body.Error.Code, test.wantStatus, test.wantCode)
		}
	}
}

func TestErrorResponseHidesUnknownErrors(t *testing.T) {
	t.Parallel()

	status, body := errorResponse(errors.New("pq: password authentication failed for user \"postgres\""))
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", status)
	}
	if body.Error.Code != codeInternal {
		t.Fatalf("code = %q, want %q", body.Error.Code, codeInternal)
	}
	if strings.Contains(body.Error.Message, "password authentication") {
		t.Fatalf("the driver message leaked into the response: %q", body.Error.Message)
	}
}

func TestWriteDataEnvelope(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	writeData(recorder, http.StatusCreated, map[string]string{"id": "th_1"})

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", recorder.Code)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("content type = %q", contentType)
	}

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	data, ok := payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("payload has no data object: %s", recorder.Body.String())
	}
	if data["id"] != "th_1" {
		t.Fatalf("data.id = %v", data["id"])
	}
	if _, present := payload["nextCursor"]; present {
		t.Fatal("a non-list response must not carry nextCursor")
	}
}

func TestWriteListEnvelope(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	writeList(recorder, http.StatusOK, []map[string]string{{"id": "th_1"}}, "cursor-1")

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if payload["nextCursor"] != "cursor-1" {
		t.Fatalf("nextCursor = %v", payload["nextCursor"])
	}
	items, ok := payload["data"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("data = %v", payload["data"])
	}

	// The last page omits nextCursor entirely.
	recorder = httptest.NewRecorder()
	writeList(recorder, http.StatusOK, []map[string]string{}, "")
	if strings.Contains(recorder.Body.String(), "nextCursor") {
		t.Fatalf("the last page must omit nextCursor: %s", recorder.Body.String())
	}
}

func TestWriteErrorShape(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
	recorder := httptest.NewRecorder()
	writeError(recorder, logger, unauthorized())

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}

	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details string `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if payload.Error.Code != codeUnauthorized {
		t.Fatalf("error.code = %q", payload.Error.Code)
	}
	if payload.Error.Message == "" {
		t.Fatal("error.message must not be empty")
	}
}

func TestDecodeJSONRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/email/sign-in",
		strings.NewReader(`{"email":"a@b.co","password":"x","unexpected":true}`))

	var body signInRequest
	err := decodeJSON(recorder, request, &body)
	if err == nil {
		t.Fatal("an unknown field must be rejected")
	}

	status, payload := errorResponse(err)
	if status != http.StatusBadRequest || payload.Error.Code != codeBadRequest {
		t.Fatalf("mapped to %d/%q", status, payload.Error.Code)
	}
	if !strings.Contains(payload.Error.Details, "unexpected") {
		t.Fatalf("details should name the field: %q", payload.Error.Details)
	}
}

func TestDecodeJSONRejectsTrailingContent(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/email/sign-in",
		strings.NewReader(`{"email":"a@b.co","password":"x"}{"email":"c@d.co"}`))

	var body signInRequest
	if err := decodeJSON(recorder, request, &body); err == nil {
		t.Fatal("a second JSON value must be rejected")
	}
}

func TestDecodeJSONRejectsEmptyAndOversizedBodies(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	empty := httptest.NewRequest(http.MethodPost, "/v1/me", strings.NewReader(""))
	var body updateMeRequest
	if err := decodeJSON(recorder, empty, &body); err == nil {
		t.Fatal("an empty body must be rejected")
	}

	recorder = httptest.NewRecorder()
	oversized := httptest.NewRequest(http.MethodPost, "/v1/me",
		strings.NewReader(`{"name":"`+strings.Repeat("a", maxBodyBytes)+`"}`))
	if err := decodeJSON(recorder, oversized, &body); err == nil {
		t.Fatal("a body over 1 MiB must be rejected")
	}
}

func TestDecodeJSONAcceptsAValidObject(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/email/sign-in",
		strings.NewReader(`{"email":"demo@codeinoven.local","password":"secret"}`))

	var body signInRequest
	if err := decodeJSON(recorder, request, &body); err != nil {
		t.Fatalf("decodeJSON: %v", err)
	}
	if body.Email != "demo@codeinoven.local" || body.Password != "secret" {
		t.Fatalf("decoded body = %+v", body)
	}
}

func TestNotFoundEnvelope(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(http.ResponseWriter, *http.Request) {})
	handler := envelopeNotFound{mux: mux}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/nope", nil))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"code":"not_found"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestParseDeviceDefaults(t *testing.T) {
	t.Parallel()

	name, platform, err := parseDevice(nil)
	if err != nil {
		t.Fatalf("parseDevice(nil): %v", err)
	}
	if name != "Desktop" || platform != "desktop" {
		t.Fatalf("defaults = %q/%q", name, platform)
	}

	name, platform, err = parseDevice(&deviceRequest{Platform: "IOS"})
	if err != nil {
		t.Fatalf("parseDevice(ios): %v", err)
	}
	if name != "iPhone" || platform != "ios" {
		t.Fatalf("ios defaults = %q/%q", name, platform)
	}

	if _, _, err := parseDevice(&deviceRequest{Platform: "watch"}); err == nil {
		t.Fatal("an unknown platform must be rejected")
	}
}

func TestParseStateFilter(t *testing.T) {
	t.Parallel()

	statuses, err := parseStateFilter("")
	if err != nil || statuses != nil {
		t.Fatalf("empty state = %v, %v", statuses, err)
	}

	statuses, err = parseStateFilter("attention")
	if err != nil {
		t.Fatalf("attention: %v", err)
	}
	if len(statuses) != 4 {
		t.Fatalf("attention group = %v", statuses)
	}

	statuses, err = parseStateFilter("working-paused")
	if err != nil || len(statuses) != 1 || statuses[0] != "working-paused" {
		t.Fatalf("exact status = %v, %v", statuses, err)
	}

	if _, err := parseStateFilter("nonsense"); err == nil {
		t.Fatal("an unknown state must be rejected")
	}
}
