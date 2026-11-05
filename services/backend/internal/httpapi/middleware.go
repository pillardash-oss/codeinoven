package httpapi

import (
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
)

// statusRecorder remembers what a handler wrote for the request log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(body)
	r.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// clientIP is the peer address without its port. Proxies are not trusted here:
// the rate limiter defends a single process behind a known deployment, and
// X-Forwarded-For would be attacker controlled.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// withRequestLog logs one line per request, in JSON, with a request id.
func withRequestLog(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		requestID := auth.NewRandomString(8)
		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-Content-Type-Options", "nosniff")

		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)

		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}

		level := slog.LevelInfo
		if recorder.status >= http.StatusInternalServerError {
			level = slog.LevelError
		} else if recorder.status >= http.StatusBadRequest {
			level = slog.LevelWarn
		}

		logger.Log(r.Context(), level, "request",
			"request_id", requestID,
			"method", r.Method,
			"path", r.URL.Path,
			"status", recorder.status,
			"bytes", recorder.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"ip", clientIP(r),
		)
	})
}

// withRecovery turns a panic into a 500 in the contract's envelope.
func withRecovery(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic recovered",
					"method", r.Method,
					"path", r.URL.Path,
					"panic", recovered,
					"stack", string(debug.Stack()),
				)
				writeJSON(w, http.StatusInternalServerError, errorBody{Error: detail{
					Code:    codeInternal,
					Message: "Something went wrong.",
				}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// withCORS answers preflights and reflects only allowed origins.
func withCORS(next http.Handler, allowed map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.Header().Add("Vary", "Origin")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withBodyLimit caps request bodies: 1 MiB everywhere, and 6 MiB for the one
// route that carries a file.
func withBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, bodyLimitFor(r))
		}
		next.ServeHTTP(w, r)
	})
}

// maxAttachmentBodyBytes is the upload limit: 4 MiB of file arrives as base64,
// which is about 5.6 MiB, plus the JSON around it.
const maxAttachmentBodyBytes = 6 << 20

// bodyLimitFor picks the limit for one request.
//
// Every other route keeps the 1 MiB default, because nothing else the contract
// defines needs more, and a phone photo cannot be sent otherwise: a 4 MiB picture
// is 5.6 MB of base64 before it is even a request body.
func bodyLimitFor(r *http.Request) int64 {
	if r.Method == http.MethodPost && isAttachmentUploadPath(r.URL.Path) {
		return maxAttachmentBodyBytes
	}
	return maxBodyBytes
}

// isAttachmentUploadPath reports whether path is POST /v1/threads/{id}/attachments.
// It is matched here rather than through the mux because the body limit has to be
// in place before routing runs.
func isAttachmentUploadPath(path string) bool {
	const prefix = "/v1/threads/"
	const suffix = "/attachments"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return false
	}
	inside := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	return inside != "" && !strings.Contains(inside, "/")
}

// originSet builds the CORS allow list: APP_ORIGINS plus the Capacitor and dev
// server origins that always work.
func originSet(configured []string) map[string]bool {
	allowed := map[string]bool{
		"capacitor://localhost": true,
		"http://localhost":      true,
		// Capacitor 8 serves Android from https://localhost by default, so the
		// packaged app is a different origin than the browser one.
		"https://localhost":     true,
		"http://127.0.0.1:5174": true,
	}
	for _, origin := range configured {
		allowed[strings.TrimRight(origin, "/")] = true
	}
	return allowed
}
