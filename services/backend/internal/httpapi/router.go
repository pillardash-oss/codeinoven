package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/config"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/mail"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// Rate limit budget for the credential endpoints: 10 attempts per 15 minutes,
// charged per IP and per email address.
const (
	credentialLimit  = 10
	credentialWindow = 15 * time.Minute
)

// Options is everything the HTTP layer needs; main wires it from the environment.
type Options struct {
	Config config.Config
	Store  *store.Store
	Logger *slog.Logger
	Mail   mail.Sender
}

// Server holds the handler dependencies.
type Server struct {
	cfg            config.Config
	store          *store.Store
	log            *slog.Logger
	mail           mail.Sender
	limiter        *auth.Limiter
	allowedOrigins map[string]bool
	providers      map[string]oauthProvider
}

// New builds the server.
func New(opts Options) *Server {
	return &Server{
		cfg:            opts.Config,
		store:          opts.Store,
		log:            opts.Logger,
		mail:           opts.Mail,
		limiter:        auth.NewLimiter(credentialLimit, credentialWindow),
		allowedOrigins: originSet(opts.Config.AppOrigins),
		providers:      oauthProviders(opts.Config),
	}
}

// Handler returns the fully wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health. /health never touches the database; /ready does.
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)

	// Identity. None of these require a session.
	mux.HandleFunc("POST /v1/auth/email/sign-up", s.handleSignUp)
	mux.HandleFunc("POST /v1/auth/email/sign-in", s.handleSignIn)
	mux.HandleFunc("POST /v1/auth/email/verify", s.handleVerifyEmail)
	mux.HandleFunc("GET /v1/auth/email/verify", s.handleVerifyEmailPage)
	mux.HandleFunc("POST /v1/auth/email/resend", s.handleResendVerification)
	mux.HandleFunc("POST /v1/auth/email/reset/request", s.handleResetRequest)
	mux.HandleFunc("POST /v1/auth/email/reset/confirm", s.handleResetConfirm)
	mux.HandleFunc("GET /v1/auth/{provider}/start", s.handleOAuthStart)
	mux.HandleFunc("GET /v1/auth/{provider}/callback", s.handleOAuthCallback)
	mux.HandleFunc("GET /v1/auth/oauth/done", s.handleOAuthDone)
	mux.HandleFunc("GET /v1/auth/providers", s.handleOAuthProviders)
	mux.HandleFunc("POST /v1/auth/oauth/exchange", s.handleOAuthExchange)

	// Identity, signed in.
	mux.Handle("POST /v1/auth/sign-out", s.requireSession(http.HandlerFunc(s.handleSignOut)))
	mux.Handle("GET /v1/auth/sessions", s.requireSession(http.HandlerFunc(s.handleListSessions)))
	mux.Handle("DELETE /v1/auth/sessions/{id}", s.requireSession(http.HandlerFunc(s.handleRevokeSession)))

	// Account.
	mux.Handle("GET /v1/me", s.requireSession(http.HandlerFunc(s.handleMe)))
	mux.Handle("PATCH /v1/me", s.requireSession(http.HandlerFunc(s.handleUpdateMe)))
	mux.Handle("GET /v1/me/devices", s.requireSession(http.HandlerFunc(s.handleListDevices)))
	mux.Handle("DELETE /v1/me/devices/{id}", s.requireSession(http.HandlerFunc(s.handleRevokeDevice)))

	// Content.
	mux.Handle("GET /v1/projects", s.requireSession(http.HandlerFunc(s.handleListProjects)))
	mux.Handle("POST /v1/projects", s.requireSession(http.HandlerFunc(s.handleCreateProject)))
	mux.Handle("GET /v1/projects/{id}", s.requireSession(http.HandlerFunc(s.handleGetProject)))
	mux.Handle("GET /v1/assistants", s.requireSession(http.HandlerFunc(s.handleListAssistants)))
	mux.Handle("GET /v1/models", s.requireSession(http.HandlerFunc(s.handleListModels)))
	mux.Handle("GET /v1/threads", s.requireSession(http.HandlerFunc(s.handleListThreads)))
	mux.Handle("POST /v1/threads", s.requireSession(http.HandlerFunc(s.handleCreateThread)))
	mux.Handle("GET /v1/threads/{id}", s.requireSession(http.HandlerFunc(s.handleGetThread)))
	mux.Handle("PATCH /v1/threads/{id}", s.requireSession(http.HandlerFunc(s.handlePatchThread)))
	mux.Handle("GET /v1/threads/{id}/messages", s.requireSession(http.HandlerFunc(s.handleListMessages)))
	mux.Handle("GET /v1/threads/{id}/usage", s.requireSession(http.HandlerFunc(s.handleThreadUsage)))
	mux.Handle("POST /v1/threads/{id}/usage/reset", s.requireSession(http.HandlerFunc(s.handleResetThreadUsage)))
	mux.Handle("POST /v1/threads/{id}/attachments", s.requireSession(http.HandlerFunc(s.handleCreateAttachment)))
	mux.Handle("GET /v1/attachments/{id}", s.requireSession(http.HandlerFunc(s.handleGetAttachment)))
	mux.Handle("DELETE /v1/attachments/{id}", s.requireSession(http.HandlerFunc(s.handleDeleteAttachment)))
	mux.Handle("POST /v1/threads/{id}/prompts", s.requireSession(http.HandlerFunc(s.handleCreatePrompt)))
	mux.Handle("GET /v1/prompts/{id}", s.requireSession(http.HandlerFunc(s.handleGetPrompt)))
	mux.Handle("DELETE /v1/prompts/{id}", s.requireSession(http.HandlerFunc(s.handleDeletePrompt)))
	mux.Handle("POST /v1/prompts/{id}/steer", s.requireSession(http.HandlerFunc(s.handleSteerPrompt)))

	// Presence and store.
	mux.Handle("POST /v1/ovens/heartbeat", s.requireSession(http.HandlerFunc(s.handleOvenHeartbeat)))
	mux.Handle("GET /v1/ovens", s.requireSession(http.HandlerFunc(s.handleListOvens)))
	mux.Handle("GET /v1/store/status", s.requireSession(http.HandlerFunc(s.handleStoreStatus)))

	var handler http.Handler = envelopeNotFound{mux: mux}
	handler = withBodyLimit(handler)
	handler = withCORS(handler, s.allowedOrigins)
	handler = withRecovery(handler, s.log)
	handler = withRequestLog(handler, s.log)
	return handler
}

// envelopeNotFound answers an unmatched route in the contract's failure shape.
type envelopeNotFound struct {
	mux *http.ServeMux
}

func (h envelopeNotFound) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := h.mux.Handler(r); pattern == "" {
		writeJSON(w, http.StatusNotFound, errorBody{Error: detail{
			Code:    codeNotFound,
			Message: "The resource does not exist.",
		}})
		return
	}
	h.mux.ServeHTTP(w, r)
}

// handleHealth never touches Postgres.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleReady checks Postgres and reports up or down.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		s.log.Warn("readiness check failed", "error", err.Error())
		writeData(w, http.StatusServiceUnavailable, map[string]string{"database": "down"})
		return
	}
	writeData(w, http.StatusOK, map[string]string{"database": "up"})
}
