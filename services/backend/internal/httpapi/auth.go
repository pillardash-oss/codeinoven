package httpapi

import (
	"context"
	"errors"
	"net/http"
	netmail "net/mail"
	"strings"
	"sync"
	"time"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/mail"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// Cookie and token lifetimes.
const (
	sessionCookieName = "cio_session"
	verifyTokenTTL    = 24 * time.Hour
	resetTokenTTL     = 30 * time.Minute
	sessionTouchEvery = time.Minute
)

// deviceRequest is the `device` object on the sign-in and sign-up bodies.
type deviceRequest struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
}

// authPayload is the sign-in and sign-up payload: {user, token, device}.
type authPayload struct {
	User   store.User   `json:"user"`
	Token  string       `json:"token"`
	Device store.Device `json:"device"`
}

// authContextKey carries the resolved session on the request context.
type authContextKey struct{}

func withAuth(ctx context.Context, authCtx store.Auth) context.Context {
	return context.WithValue(ctx, authContextKey{}, authCtx)
}

// authFrom returns the resolved session for a request inside requireSession.
func authFrom(ctx context.Context) (store.Auth, bool) {
	authCtx, ok := ctx.Value(authContextKey{}).(store.Auth)
	return authCtx, ok
}

// dummyHash makes a failed sign-in cost the same as a successful one for an
// unknown address, so response time does not reveal whether an account exists.
var dummyHash = sync.OnceValue(func() string {
	hash, err := auth.HashPassword("timing-equaliser-not-a-real-password")
	if err != nil {
		return ""
	}
	return hash
})

// requireSession resolves the bearer token or session cookie, refreshes the
// session's last_used_at at most once a minute, and hands the handler the
// session, user and store.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := s.sessionToken(r)
		if !ok {
			writeError(w, s.log, unauthorized())
			return
		}

		ctx := r.Context()
		authCtx, err := s.store.AuthByTokenHash(ctx, auth.HashToken(token))
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, s.log, unauthorized())
				return
			}
			writeError(w, s.log, err)
			return
		}

		// A user whose store was never provisioned (an interrupted sign-up) gets
		// one lazily, so a failure at sign-up time is not permanent.
		if authCtx.Store == nil {
			rec, err := s.store.EnsureStore(ctx, auth.NewID(auth.PrefixStore), authCtx.User.ID)
			if err != nil {
				writeError(w, s.log, err)
				return
			}
			authCtx.Store = &rec
		}

		if s.store.Now().Sub(authCtx.Session.LastUsedAt) > sessionTouchEvery {
			if err := s.store.TouchSession(ctx, authCtx.Session.ID); err != nil {
				s.log.Warn("could not touch session", "error", err.Error())
			}
			if err := s.store.TouchDevice(ctx, authCtx.Session.DeviceID); err != nil {
				s.log.Warn("could not touch device", "error", err.Error())
			}
		}

		next.ServeHTTP(w, r.WithContext(withAuth(ctx, authCtx)))
	})
}

// sessionToken reads the bearer header first, then the cookie.
func (s *Server) sessionToken(r *http.Request) (string, bool) {
	if header := strings.TrimSpace(r.Header.Get("Authorization")); header != "" {
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return "", false
		}
		token := strings.TrimSpace(parts[1])
		return token, token != ""
	}

	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	return cookie.Value, true
}

// setSessionCookie mirrors the bearer token into a cookie for browser builds.
// Native builds keep the token in the keychain and send the header.
func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   !s.cfg.IsDevelopment(),
		Expires:  time.Now().Add(s.cfg.SessionTTL),
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
	})
}

// clearSessionCookie removes the cookie on sign-out.
func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   !s.cfg.IsDevelopment(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// parseEmail validates and lower cases an address.
func parseEmail(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", badRequest("email is required")
	}
	if len(trimmed) > 254 {
		return "", badRequest("email must be at most 254 characters")
	}
	parsed, err := netmail.ParseAddress(trimmed)
	if err != nil || parsed.Address != trimmed {
		return "", badRequest("email must be a valid email address")
	}
	return strings.ToLower(parsed.Address), nil
}

// parseOptionalName trims a display name and caps it at 80 characters.
func parseOptionalName(raw string) (*string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	if len([]rune(trimmed)) > 80 {
		return nil, badRequest("name must be at most 80 characters")
	}
	return &trimmed, nil
}

// parseDevice fills in the device name and validates the platform enum.
func parseDevice(req *deviceRequest) (string, string, error) {
	platform := "desktop"
	name := ""
	if req != nil {
		if value := strings.ToLower(strings.TrimSpace(req.Platform)); value != "" {
			platform = value
		}
		name = strings.TrimSpace(req.Name)
	}

	switch platform {
	case "desktop", "ios", "android":
	default:
		return "", "", badRequest("device.platform must be desktop, ios or android")
	}

	if name == "" {
		name = defaultDeviceName(platform)
	}
	if len([]rune(name)) > 80 {
		return "", "", badRequest("device.name must be at most 80 characters")
	}
	return name, platform, nil
}

func defaultDeviceName(platform string) string {
	switch platform {
	case "ios":
		return "iPhone"
	case "android":
		return "Android device"
	default:
		return "Desktop"
	}
}

// passwordPolicyError converts the auth policy error into a 400 with details.
func passwordPolicyError(err error) *APIError {
	return badRequest(err.Error())
}

// signUpRequest is the POST /v1/auth/email/sign-up body.
type signUpRequest struct {
	Email    string         `json:"email"`
	Password string         `json:"password"`
	Name     string         `json:"name"`
	Device   *deviceRequest `json:"device"`
}

func (s *Server) handleSignUp(w http.ResponseWriter, r *http.Request) {
	var req signUpRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}

	email, err := parseEmail(req.Email)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeError(w, s.log, passwordPolicyError(err))
		return
	}
	name, err := parseOptionalName(req.Name)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	deviceName, platform, err := parseDevice(req.Device)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	ip := clientIP(r)
	keys := []string{"sign-up:ip:" + ip, "sign-up:email:" + email}
	if !s.limiter.AllowAll(keys...) {
		writeError(w, s.log, rateLimited())
		return
	}

	ctx := r.Context()
	passwordHash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, s.log, internalError())
		return
	}

	user, err := s.store.CreateUser(ctx, auth.NewID(auth.PrefixUser), email, name)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	if err := s.store.UpdatePasswordHash(ctx, user.ID, passwordHash); err != nil {
		writeError(w, s.log, err)
		return
	}

	device, err := s.store.CreateDevice(ctx, auth.NewID(auth.PrefixDevice), user.ID, deviceName, platform)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	// This device holds the session just created, so it is the current one.
	device.Current = true

	// The store is provisioned here, but requireSession provisions it lazily too,
	// so a failure at this point does not lock the account out.
	if _, err := s.store.ProvisionStore(ctx, auth.NewID(auth.PrefixStore), user.ID); err != nil {
		s.log.Error("could not provision store at sign-up", "user", user.ID, "error", err.Error())
	}

	_, token, err := s.startSession(ctx, user.ID, device.ID, r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	s.sendVerification(ctx, user, email)

	s.setSessionCookie(w, token)
	writeData(w, http.StatusCreated, authPayload{User: user, Token: token, Device: device})
}

// signInRequest is the POST /v1/auth/email/sign-in body.
type signInRequest struct {
	Email    string         `json:"email"`
	Password string         `json:"password"`
	Device   *deviceRequest `json:"device"`
}

func (s *Server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	var req signInRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}

	email, err := parseEmail(req.Email)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	if req.Password == "" {
		writeError(w, s.log, badRequest("password is required"))
		return
	}
	deviceName, platform, err := parseDevice(req.Device)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	ip := clientIP(r)
	ipKey := "sign-in:ip:" + ip
	emailKey := "sign-in:email:" + email
	if !s.limiter.AllowAll(ipKey, emailKey) {
		writeError(w, s.log, rateLimited())
		return
	}

	ctx := r.Context()
	user, err := s.store.UserByEmail(ctx, email)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			writeError(w, s.log, err)
			return
		}
		verifyDummyPassword(req.Password)
		writeError(w, s.log, invalidCredentials())
		return
	}

	passwordHash, err := s.store.PasswordHash(ctx, user.ID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			writeError(w, s.log, err)
			return
		}
		verifyDummyPassword(req.Password)
		writeError(w, s.log, invalidCredentials())
		return
	}

	ok, err := auth.VerifyPassword(req.Password, passwordHash)
	if err != nil {
		s.log.Error("stored password hash is unreadable", "user", user.ID, "error", err.Error())
		writeError(w, s.log, internalError())
		return
	}
	if !ok {
		writeError(w, s.log, invalidCredentials())
		return
	}

	s.limiter.Reset(emailKey)

	device, err := s.store.FindDevice(ctx, user.ID, deviceName, platform)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			writeError(w, s.log, err)
			return
		}
		device, err = s.store.CreateDevice(ctx, auth.NewID(auth.PrefixDevice), user.ID, deviceName, platform)
		if err != nil {
			writeError(w, s.log, err)
			return
		}
	} else {
		if err := s.store.TouchDevice(ctx, device.ID); err != nil {
			s.log.Warn("could not touch device", "error", err.Error())
		}
		device.LastSeenAt = store.FromTime(s.store.Now())
	}
	device.Current = true

	// A user without a store (sign-up interrupted before provisioning, or an
	// OAuth account created elsewhere) gets one now.
	if _, err := s.store.EnsureStore(ctx, auth.NewID(auth.PrefixStore), user.ID); err != nil {
		writeError(w, s.log, err)
		return
	}

	_, token, err := s.startSession(ctx, user.ID, device.ID, r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	s.setSessionCookie(w, token)
	writeData(w, http.StatusOK, authPayload{User: user, Token: token, Device: device})
}

// startSession mints a token, stores only its hash, and returns the token.
func (s *Server) startSession(
	ctx context.Context, userID, deviceID string, r *http.Request,
) (store.Session, string, error) {
	token, tokenHash := auth.NewSessionToken()

	var userAgent *string
	if value := strings.TrimSpace(r.UserAgent()); value != "" {
		userAgent = &value
	}

	session, err := s.store.CreateSession(
		ctx, auth.NewID(auth.PrefixSession), userID, deviceID, tokenHash, userAgent, s.cfg.SessionTTL,
	)
	if err != nil {
		return store.Session{}, "", err
	}
	return session, token, nil
}

// verifyDummyPassword spends the same argon2 work a real verification would.
func verifyDummyPassword(password string) {
	hash := dummyHash()
	if hash == "" {
		return
	}
	_, _ = auth.VerifyPassword(password, hash)
}

// sendVerification mints a single-use token and hands it to the mail sender.
func (s *Server) sendVerification(ctx context.Context, user store.User, email string) {
	token, tokenHash := auth.NewEmailToken()
	if err := s.store.CreateEmailToken(
		ctx, auth.NewID(auth.PrefixEmailToken), user.ID, "verify", tokenHash,
		s.store.Now().Add(verifyTokenTTL),
	); err != nil {
		s.log.Error("could not create verification token", "user", user.ID, "error", err.Error())
		return
	}

	name := email
	if user.Name != nil {
		name = *user.Name
	}
	link := mail.Link(s.cfg.PublicBaseURL, "/v1/auth/email/verify", token)
	if err := s.mail.SendVerification(ctx, email, name, link); err != nil {
		s.log.Error("could not send verification mail", "user", user.ID, "error", err.Error())
	}
}

// verifyRequest is the POST /v1/auth/email/verify body.
type verifyRequest struct {
	Token string `json:"token"`
}

func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	if strings.TrimSpace(req.Token) == "" {
		writeError(w, s.log, badRequest("token is required"))
		return
	}

	user, err := s.verifyEmailToken(r.Context(), req.Token)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, user)
}

// verifyEmailToken consumes a verification token and marks the address verified.
func (s *Server) verifyEmailToken(ctx context.Context, token string) (store.User, error) {
	userID, err := s.store.ConsumeEmailToken(ctx, auth.HashToken(token), "verify")
	if err != nil {
		return store.User{}, err
	}
	return s.store.MarkEmailVerified(ctx, userID, s.store.Now())
}

// handleVerifyEmailPage renders the link a development verification mail points
// at, so clicking it in the log confirms the address.
func (s *Server) handleVerifyEmailPage(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		writePage(w, http.StatusBadRequest, "Verification failed", "This link is missing its token.")
		return
	}

	if _, err := s.verifyEmailToken(r.Context(), token); err != nil {
		writePage(w, http.StatusBadRequest, "Verification failed",
			"This link is invalid or has expired. Request a new one from the app.")
		return
	}
	writePage(w, http.StatusOK, "Email verified", "You can close this tab and return to CodeInOven.")
}

// emailOnlyRequest is the body of resend and reset/request.
type emailOnlyRequest struct {
	Email string `json:"email"`
}

func (s *Server) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var req emailOnlyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	email, err := parseEmail(req.Email)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	ip := clientIP(r)
	if !s.limiter.AllowAll("resend:ip:"+ip, "resend:email:"+email) {
		writeError(w, s.log, rateLimited())
		return
	}

	ctx := r.Context()
	user, err := s.store.UserByEmail(ctx, email)
	switch {
	case err == nil:
		s.sendVerification(ctx, user, email)
	case !errors.Is(err, store.ErrNotFound):
		writeError(w, s.log, err)
		return
	}

	// Always 202: never reveal whether the address exists.
	writeData(w, http.StatusAccepted, map[string]bool{"sent": true})
}

func (s *Server) handleResetRequest(w http.ResponseWriter, r *http.Request) {
	var req emailOnlyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	email, err := parseEmail(req.Email)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	ip := clientIP(r)
	if !s.limiter.AllowAll("reset:ip:"+ip, "reset:email:"+email) {
		writeError(w, s.log, rateLimited())
		return
	}

	ctx := r.Context()
	user, err := s.store.UserByEmail(ctx, email)
	switch {
	case err == nil:
		s.sendPasswordReset(ctx, user, email)
	case !errors.Is(err, store.ErrNotFound):
		writeError(w, s.log, err)
		return
	}

	writeData(w, http.StatusAccepted, map[string]bool{"sent": true})
}

// sendPasswordReset mints a 30 minute reset token and mails the link.
func (s *Server) sendPasswordReset(ctx context.Context, user store.User, email string) {
	token, tokenHash := auth.NewEmailToken()
	if err := s.store.CreateEmailToken(
		ctx, auth.NewID(auth.PrefixEmailToken), user.ID, "reset", tokenHash,
		s.store.Now().Add(resetTokenTTL),
	); err != nil {
		s.log.Error("could not create reset token", "user", user.ID, "error", err.Error())
		return
	}

	name := email
	if user.Name != nil {
		name = *user.Name
	}
	link := mail.Link(s.cfg.PublicBaseURL, "/v1/auth/email/reset", token)
	if err := s.mail.SendPasswordReset(ctx, email, name, link); err != nil {
		s.log.Error("could not send reset mail", "user", user.ID, "error", err.Error())
	}
}

// resetConfirmRequest is the POST /v1/auth/email/reset/confirm body.
type resetConfirmRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (s *Server) handleResetConfirm(w http.ResponseWriter, r *http.Request) {
	var req resetConfirmRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	if strings.TrimSpace(req.Token) == "" {
		writeError(w, s.log, badRequest("token is required"))
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeError(w, s.log, passwordPolicyError(err))
		return
	}

	passwordHash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, s.log, internalError())
		return
	}

	ctx := r.Context()
	userID, revoked, err := s.store.ResetPassword(ctx, auth.HashToken(req.Token), passwordHash)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("password reset", "user", userID, "sessions_revoked", revoked)
	s.clearSessionCookie(w)
	writeData(w, http.StatusOK, map[string]bool{"reset": true})
}

func (s *Server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	if err := s.store.RevokeSession(r.Context(), authCtx.User.ID, authCtx.Session.ID); err != nil &&
		!errors.Is(err, store.ErrNotFound) {
		writeError(w, s.log, err)
		return
	}
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	sessions, err := s.store.ListSessions(r.Context(), authCtx.User.ID, authCtx.Session.ID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	writeData(w, http.StatusOK, sessions)
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	sessionID := r.PathValue("id")
	if strings.TrimSpace(sessionID) == "" {
		writeError(w, s.log, badRequest("session id is required"))
		return
	}
	if err := s.store.RevokeSession(r.Context(), authCtx.User.ID, sessionID); err != nil {
		writeError(w, s.log, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
