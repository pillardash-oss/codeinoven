package httpapi

import (
	"errors"
	"html"
	"net/http"
	"strconv"
	"strings"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// changePasswordRequest is the POST /v1/me/password body. CurrentPassword is
// required whenever the account already has a password; an account created
// through Google or GitHub sets its first one without it.
type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	var req changePasswordRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		writeError(w, s.log, passwordPolicyError(err))
		return
	}
	if !s.limiter.AllowAll("password:user:" + authCtx.User.ID) {
		writeError(w, s.log, rateLimited())
		return
	}
	if err := s.confirmPassword(r, authCtx.User.ID, req.CurrentPassword); err != nil {
		writeError(w, s.log, err)
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, s.log, internalError())
		return
	}
	revoked, err := s.store.ChangePassword(r.Context(), authCtx.User.ID, authCtx.Session.ID, hash)
	if err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("password changed", "user", authCtx.User.ID, "sessions_revoked", revoked)
	writeData(w, http.StatusOK, map[string]int64{"sessionsRevoked": revoked})
}

// deleteAccountRequest is the DELETE /v1/me body. A password account confirms
// with its password; an account without one confirms by typing its address.
type deleteAccountRequest struct {
	Password string `json:"password"`
	Email    string `json:"email"`
}

func (s *Server) handleDeleteMe(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := authFrom(r.Context())
	if !ok {
		writeError(w, s.log, unauthorized())
		return
	}
	var req deleteAccountRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	if !s.limiter.AllowAll("delete:user:" + authCtx.User.ID) {
		writeError(w, s.log, rateLimited())
		return
	}

	ctx := r.Context()
	_, err := s.store.PasswordHash(ctx, authCtx.User.ID)
	switch {
	case err == nil:
		if err := s.confirmPassword(r, authCtx.User.ID, req.Password); err != nil {
			writeError(w, s.log, err)
			return
		}
	case errors.Is(err, store.ErrNotFound):
		if !strings.EqualFold(strings.TrimSpace(req.Email), authCtx.User.Email) {
			writeError(w, s.log, badRequest("type the account's email address to confirm"))
			return
		}
	default:
		writeError(w, s.log, err)
		return
	}

	if err := s.store.DeleteUser(ctx, authCtx.User.ID); err != nil {
		writeError(w, s.log, err)
		return
	}
	s.log.Info("account deleted", "user", authCtx.User.ID)
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// confirmPassword checks the caller's current password. An account with no
// password passes, since there is nothing to confirm against.
func (s *Server) confirmPassword(r *http.Request, userID, password string) error {
	hash, err := s.store.PasswordHash(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if password == "" {
		return badRequest("current password is required")
	}
	match, err := auth.VerifyPassword(password, hash)
	if err != nil {
		return internalError()
	}
	if !match {
		return invalidCredentials()
	}
	return nil
}

// resetFormTemplate is the page a reset mail opens: one field and one button,
// posting back to the same path. It carries no script, like every other page.
const resetFormTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose a new password · CodeInOven</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  background: #101014; color: #f4f4f5; padding: 24px; }
main { width: 100%; max-width: 24rem; }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
label { display: block; font-size: 0.875rem; color: #d4d4d8; margin-bottom: 0.5rem; }
input { box-sizing: border-box; width: 100%; padding: 0.75rem; font: inherit; color: inherit;
  background: #18181b; border: 1px solid #3f3f46; border-radius: 0; }
.actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
button { padding: 0.75rem 1.25rem; font: inherit; border: 0; border-radius: 0;
  background: #f4f4f5; color: #101014; }
</style>
</head>
<body>
<main>
<h1>Choose a new password</h1>
<form method="post" action="/v1/auth/email/reset">
<input type="hidden" name="token" value="{{token}}">
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="{{min}}" required autofocus>
<div class="actions"><button type="submit">Set password</button></div>
</form>
</main>
</body>
</html>
`

// handleResetPasswordPage renders the form a reset mail links to.
func (s *Server) handleResetPasswordPage(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		writePage(w, http.StatusBadRequest, "Reset failed", "This link is missing its token.")
		return
	}
	body := strings.Replace(resetFormTemplate, "{{token}}", html.EscapeString(token), 1)
	body = strings.Replace(body, "{{min}}", strconv.Itoa(auth.MinPasswordLength), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

// handleResetPasswordForm accepts the form above and confirms the reset.
func (s *Server) handleResetPasswordForm(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := r.ParseForm(); err != nil {
		writePage(w, http.StatusBadRequest, "Reset failed", "The form could not be read.")
		return
	}
	token := strings.TrimSpace(r.PostForm.Get("token"))
	password := r.PostForm.Get("password")
	if token == "" {
		writePage(w, http.StatusBadRequest, "Reset failed", "This link is missing its token.")
		return
	}
	if err := auth.ValidatePassword(password); err != nil {
		writePage(w, http.StatusBadRequest, "Reset failed", err.Error()+" Go back and try again.")
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		writePage(w, http.StatusInternalServerError, "Reset failed", "Something went wrong. Try again.")
		return
	}
	userID, revoked, err := s.store.ResetPassword(r.Context(), auth.HashToken(token), hash)
	if err != nil {
		writePage(w, http.StatusBadRequest, "Reset failed",
			"This link is invalid or has expired. Request a new one from the app.")
		return
	}
	s.log.Info("password reset", "user", userID, "sessions_revoked", revoked)
	writePage(w, http.StatusOK, "Password changed",
		"Every device was signed out. Return to CodeInOven and sign in with the new password.")
}
