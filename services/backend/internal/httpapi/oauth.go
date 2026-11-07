package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/config"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// OAuth state cookie: signed with SESSION_SECRET, valid for ten minutes.
const (
	oauthStateCookie = "cio_oauth_state"
	oauthStateTTL    = 10 * time.Minute
	// oauthAppRedirect is the app's own deep link. The callback appends the
	// one-time code to it and the native shell picks the link up.
	oauthAppRedirect = "codeinoven://auth"
	// oauthHandoffTTL is how long the app has to trade the code for a session.
	oauthHandoffTTL = 2 * time.Minute
)

// oauthProvider is one configured identity provider.
type oauthProvider struct {
	name        string
	label       string
	credentials config.OAuth
	authURL     string
	tokenURL    string
	userInfoURL string
	emailsURL   string
	scope       string
	// authParams are extra query parameters on the authorize redirect.
	authParams map[string]string
}

// oauthProviders builds the provider table. A provider stays in the map even
// when its credentials are absent, so /start can answer 501 instead of 404.
func oauthProviders(cfg config.Config) map[string]oauthProvider {
	return map[string]oauthProvider{
		"google": {
			name:        "google",
			label:       "Google",
			credentials: cfg.Google,
			authURL:     "https://accounts.google.com/o/oauth2/v2/auth",
			tokenURL:    "https://oauth2.googleapis.com/token",
			userInfoURL: "https://openidconnect.googleapis.com/v1/userinfo",
			scope:       "openid email profile",
			authParams:  map[string]string{"access_type": "offline", "prompt": "select_account"},
		},
		"github": {
			name:        "github",
			label:       "GitHub",
			credentials: cfg.GitHub,
			authURL:     "https://github.com/login/oauth/authorize",
			tokenURL:    "https://github.com/login/oauth/access_token",
			userInfoURL: "https://api.github.com/user",
			emailsURL:   "https://api.github.com/user/emails",
			scope:       "read:user user:email",
		},
	}
}

// oauthClient is the HTTP client for provider calls. It has a deadline because a
// hung provider must not hang a sign-in forever.
var oauthClient = &http.Client{Timeout: 15 * time.Second}

// oauthProfile is the provider independent identity we keep.
type oauthProfile struct {
	ProviderID    string
	Email         string
	EmailVerified bool
	Name          string
	AvatarURL     string
}

// handleOAuthStart redirects to the provider, or answers 501 when that provider
// has no credentials configured.
func (s *Server) handleOAuthStart(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("provider")
	provider, ok := s.providers[name]
	if !ok {
		writeError(w, s.log, notFound("Unknown sign-in provider."))
		return
	}
	if !provider.credentials.Enabled() {
		writeError(w, s.log, unsupported(provider.label+" sign-in is not configured on this server."))
		return
	}

	platform := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("platform")))
	switch platform {
	case "":
		platform = "desktop"
	case "desktop", "ios", "android":
	default:
		writeError(w, s.log, badRequest("platform must be desktop, ios or android"))
		return
	}

	redirect, err := s.oauthRedirectTarget(r.URL.Query().Get("redirect"))
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	state := s.signState(provider.name, platform, redirect)
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    state,
		Path:     "/v1/auth",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   !s.cfg.IsDevelopment(),
		Expires:  time.Now().Add(oauthStateTTL),
		MaxAge:   int(oauthStateTTL.Seconds()),
	})

	params := url.Values{
		"response_type": {"code"},
		"client_id":     {provider.credentials.ClientID},
		"redirect_uri":  {s.oauthRedirectURL(provider.name)},
		"scope":         {provider.scope},
		"state":         {state},
	}
	for key, value := range provider.authParams {
		params.Set(key, value)
	}

	http.Redirect(w, r, provider.authURL+"?"+params.Encode(), http.StatusFound)
}

// oauthRedirectURL is the callback registered with the provider.
func (s *Server) oauthRedirectURL(providerName string) string {
	return s.cfg.PublicBaseURL + "/v1/auth/" + providerName + "/callback"
}

// signState binds a provider, a device platform and a timestamp into an HMAC
// signed value. It is stored in a cookie and echoed back by the provider.
func (s *Server) signState(providerName, platform, redirect string) string {
	payload := strings.Join([]string{
		auth.NewOpaqueToken(),
		providerName,
		platform,
		strconv.FormatInt(time.Now().Unix(), 10),
		base64.RawURLEncoding.EncodeToString([]byte(redirect)),
	}, "|")
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(s.stateMAC(payload))
}

// oauthState is what a signed state value carries across the provider round trip.
type oauthState struct {
	Platform string
	// Redirect is where the callback sends the browser afterwards. Empty means
	// this service's own result page, which is the desktop and browser case.
	Redirect string
}

// verifyState checks the signature, the age and the provider binding, and
// returns where the flow came from and where it should hand off.
func (s *Server) verifyState(state, providerName string) (oauthState, error) {
	parts := strings.Split(state, ".")
	if len(parts) != 2 {
		return oauthState{}, errors.New("malformed state")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return oauthState{}, errors.New("malformed state payload")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return oauthState{}, errors.New("malformed state signature")
	}
	payload := string(payloadBytes)
	if !hmac.Equal(signature, s.stateMAC(payload)) {
		return oauthState{}, errors.New("state signature mismatch")
	}

	fields := strings.Split(payload, "|")
	if len(fields) != 5 {
		return oauthState{}, errors.New("malformed state fields")
	}
	if fields[1] != providerName {
		return oauthState{}, errors.New("state provider mismatch")
	}

	issuedAt, err := strconv.ParseInt(fields[3], 10, 64)
	if err != nil {
		return oauthState{}, errors.New("malformed state timestamp")
	}
	if time.Since(time.Unix(issuedAt, 0)) > oauthStateTTL {
		return oauthState{}, errors.New("state expired")
	}

	redirectBytes, err := base64.RawURLEncoding.DecodeString(fields[4])
	if err != nil {
		return oauthState{}, errors.New("malformed state redirect")
	}

	return oauthState{Platform: fields[2], Redirect: string(redirectBytes)}, nil
}

func (s *Server) stateMAC(payload string) []byte {
	mac := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

// handleOAuthCallback exchanges the code, links the account, starts a session,
// and redirects to a page on this service's own origin. The token is never put
// in a redirect.
func (s *Server) handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("provider")
	provider, ok := s.providers[name]
	if !ok {
		writeError(w, s.log, notFound("Unknown sign-in provider."))
		return
	}
	if !provider.credentials.Enabled() {
		writeError(w, s.log, unsupported(provider.label+" sign-in is not configured on this server."))
		return
	}

	query := r.URL.Query()
	if providerError := query.Get("error"); providerError != "" {
		s.redirectOAuthDone(w, r, "error", "provider_"+providerError)
		return
	}

	state := query.Get("state")
	cookie, err := r.Cookie(oauthStateCookie)
	if err != nil || cookie.Value == "" || !hmac.Equal([]byte(cookie.Value), []byte(state)) {
		s.redirectOAuthDone(w, r, "error", "state")
		return
	}

	stateValues, err := s.verifyState(state, name)
	if err != nil {
		s.log.Warn("oauth state rejected", "provider", name, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "state")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    "",
		Path:     "/v1/auth",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   !s.cfg.IsDevelopment(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})

	code := strings.TrimSpace(query.Get("code"))
	if code == "" {
		s.redirectOAuthDone(w, r, "error", "missing_code")
		return
	}

	ctx := r.Context()
	accessToken, err := s.exchangeOAuthCode(ctx, provider, code)
	if err != nil {
		s.log.Error("oauth token exchange failed", "provider", name, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "exchange")
		return
	}

	profile, err := s.fetchOAuthProfile(ctx, provider, accessToken)
	if err != nil {
		s.log.Error("oauth profile fetch failed", "provider", name, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "profile")
		return
	}

	user, err := s.oauthUser(ctx, provider, profile)
	if err != nil {
		s.log.Error("oauth account link failed", "provider", name, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "account")
		return
	}

	platform := stateValues.Platform
	deviceName := defaultDeviceName(platform)
	device, err := s.store.FindDevice(ctx, user.ID, deviceName, platform)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Error("oauth device lookup failed", "user", user.ID, "error", err.Error())
			s.redirectOAuthDone(w, r, "error", "device")
			return
		}
		device, err = s.store.CreateDevice(
			ctx, auth.NewID(auth.PrefixDevice), user.ID, deviceName, platform)
		if err != nil {
			s.log.Error("oauth device creation failed", "user", user.ID, "error", err.Error())
			s.redirectOAuthDone(w, r, "error", "device")
			return
		}
	}

	if _, err := s.store.EnsureStore(ctx, auth.NewID(auth.PrefixStore), user.ID); err != nil {
		s.log.Error("oauth store provisioning failed", "user", user.ID, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "store")
		return
	}

	_, token, err := s.startSession(ctx, user.ID, device.ID, r)
	if err != nil {
		s.log.Error("oauth session creation failed", "user", user.ID, "error", err.Error())
		s.redirectOAuthDone(w, r, "error", "session")
		return
	}

	s.log.Info("oauth sign-in", "provider", name, "user", user.ID, "device", device.ID, "platform", platform)

	// A native app cannot read this browser's cookie, so it gets a one-time code
	// instead and trades it for its own session over HTTPS. A browser keeps the
	// cookie and is sent to the result page.
	if stateValues.Redirect != "" {
		code, err := s.createOAuthHandoff(ctx, user.ID, device.ID)
		if err != nil {
			s.log.Error("oauth handoff failed", "user", user.ID, "error", err.Error())
			s.redirectOAuthHandoff(w, r, stateValues.Redirect, "", "handoff")
			return
		}
		s.redirectOAuthHandoff(w, r, stateValues.Redirect, code, "")
		return
	}

	s.setSessionCookie(w, token)
	s.redirectOAuthDone(w, r, "ok", "")
}

// exchangeOAuthCode trades an authorization code for an access token.
func (s *Server) exchangeOAuthCode(
	ctx context.Context, provider oauthProvider, code string,
) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {provider.credentials.ClientID},
		"client_secret": {provider.credentials.ClientSecret},
		"redirect_uri":  {s.oauthRedirectURL(provider.name)},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.tokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := oauthClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint answered %d", resp.StatusCode)
	}

	var payload struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if payload.Error != "" {
		return "", fmt.Errorf("provider rejected the code: %s", payload.ErrorDescription)
	}
	if payload.AccessToken == "" {
		return "", errors.New("token response carried no access_token")
	}
	return payload.AccessToken, nil
}

// fetchOAuthProfile reads the provider's user info and normalises it.
func (s *Server) fetchOAuthProfile(
	ctx context.Context, provider oauthProvider, accessToken string,
) (oauthProfile, error) {
	switch provider.name {
	case "google":
		var payload struct {
			Sub           string `json:"sub"`
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
			Name          string `json:"name"`
			Picture       string `json:"picture"`
		}
		if err := s.getProviderJSON(ctx, provider.userInfoURL, accessToken, &payload); err != nil {
			return oauthProfile{}, err
		}
		if payload.Sub == "" {
			return oauthProfile{}, errors.New("google profile has no subject")
		}
		return oauthProfile{
			ProviderID:    payload.Sub,
			Email:         strings.ToLower(strings.TrimSpace(payload.Email)),
			EmailVerified: payload.EmailVerified,
			Name:          payload.Name,
			AvatarURL:     payload.Picture,
		}, nil

	case "github":
		var payload struct {
			ID        int64  `json:"id"`
			Login     string `json:"login"`
			Name      string `json:"name"`
			Email     string `json:"email"`
			AvatarURL string `json:"avatar_url"`
		}
		if err := s.getProviderJSON(ctx, provider.userInfoURL, accessToken, &payload); err != nil {
			return oauthProfile{}, err
		}
		if payload.ID == 0 {
			return oauthProfile{}, errors.New("github profile has no id")
		}

		email := strings.ToLower(strings.TrimSpace(payload.Email))
		verified := false
		var emails []struct {
			Email    string `json:"email"`
			Primary  bool   `json:"primary"`
			Verified bool   `json:"verified"`
		}
		if err := s.getProviderJSON(ctx, provider.emailsURL, accessToken, &emails); err != nil {
			return oauthProfile{}, err
		}
		for _, candidate := range emails {
			if candidate.Verified && (candidate.Primary || email == "") {
				email = strings.ToLower(strings.TrimSpace(candidate.Email))
				verified = true
				if candidate.Primary {
					break
				}
			}
		}

		name := payload.Name
		if strings.TrimSpace(name) == "" {
			name = payload.Login
		}
		return oauthProfile{
			ProviderID:    strconv.FormatInt(payload.ID, 10),
			Email:         email,
			EmailVerified: verified,
			Name:          name,
			AvatarURL:     payload.AvatarURL,
		}, nil
	}

	return oauthProfile{}, fmt.Errorf("unsupported provider %q", provider.name)
}

// getProviderJSON performs one authenticated GET and decodes the JSON body.
func (s *Server) getProviderJSON(
	ctx context.Context, endpoint, accessToken string, dst any,
) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build provider request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "codeinoven-backend")

	resp, err := oauthClient.Do(req)
	if err != nil {
		return fmt.Errorf("provider request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("provider answered %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(dst); err != nil {
		return fmt.Errorf("decode provider response: %w", err)
	}
	return nil
}

// oauthUser finds, links or creates the account behind an OAuth identity.
func (s *Server) oauthUser(
	ctx context.Context, provider oauthProvider, profile oauthProfile,
) (store.User, error) {
	if userID, err := s.store.AccountUserID(ctx, provider.name, profile.ProviderID); err == nil {
		user, err := s.store.UserByID(ctx, userID)
		if err != nil {
			return store.User{}, err
		}
		return s.verifyFromProvider(ctx, user, profile)
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.User{}, err
	}

	if profile.Email == "" {
		return store.User{}, errors.New("provider returned no email address")
	}

	existing, err := s.store.UserByEmail(ctx, profile.Email)
	switch {
	case err == nil:
		if err := s.store.LinkAccount(
			ctx, auth.NewID(auth.PrefixAccount), existing.ID, provider.name, profile.ProviderID,
		); err != nil {
			return store.User{}, err
		}
		return s.verifyFromProvider(ctx, existing, profile)

	case !errors.Is(err, store.ErrNotFound):
		return store.User{}, err
	}

	var name *string
	if trimmed := strings.TrimSpace(profile.Name); trimmed != "" {
		name = &trimmed
	}
	user, err := s.store.CreateUser(ctx, auth.NewID(auth.PrefixUser), profile.Email, name)
	if err != nil {
		return store.User{}, err
	}
	if err := s.store.LinkAccount(
		ctx, auth.NewID(auth.PrefixAccount), user.ID, provider.name, profile.ProviderID,
	); err != nil {
		return store.User{}, err
	}
	if profile.AvatarURL != "" {
		if err := s.store.SetUserAvatar(ctx, user.ID, profile.AvatarURL); err != nil {
			s.log.Warn("could not store avatar", "user", user.ID, "error", err.Error())
		}
	}

	user, err = s.verifyFromProvider(ctx, user, profile)
	if err != nil {
		return store.User{}, err
	}

	if _, err := s.store.ProvisionStore(ctx, auth.NewID(auth.PrefixStore), user.ID); err != nil {
		s.log.Error("could not provision store for oauth user", "user", user.ID, "error", err.Error())
	}
	return user, nil
}

// verifyFromProvider trusts the provider's verified email claim.
func (s *Server) verifyFromProvider(
	ctx context.Context, user store.User, profile oauthProfile,
) (store.User, error) {
	if !profile.EmailVerified || user.EmailVerifiedAt != nil {
		return user, nil
	}
	verified, err := s.store.MarkEmailVerified(ctx, user.ID, s.store.Now())
	if err != nil {
		return store.User{}, err
	}
	return verified, nil
}

// redirectOAuthDone sends the browser to this service's own result page; the
// session token stays in the cookie and never appears in a URL.
func (s *Server) redirectOAuthDone(w http.ResponseWriter, r *http.Request, status, reason string) {
	target := s.cfg.PublicBaseURL + "/v1/auth/oauth/done?status=" + url.QueryEscape(status)
	if reason != "" {
		target += "&reason=" + url.QueryEscape(reason)
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// handleOAuthDone renders the page the callback redirects to.
func (s *Server) handleOAuthDone(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "ok" {
		writePage(w, http.StatusOK, "Signed in",
			"You are signed in to CodeInOven. Return to the app, or close this tab.")
		return
	}
	writePage(w, http.StatusBadRequest, "Sign-in failed",
		"The provider did not complete the sign-in. Return to CodeInOven and try again.")
}

// oauthRedirectTarget validates where the callback may hand the browser back to.
//
// Only two shapes are allowed: the app's own deep link, and a browser origin
// this service already trusts for CORS. Anything else is refused rather than
// becoming an open redirect.
func (s *Server) oauthRedirectTarget(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if strings.EqualFold(value, oauthAppRedirect) {
		return oauthAppRedirect, nil
	}

	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", badRequest("redirect is not a valid app target")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", badRequest("redirect must use http or https")
	}
	origin := parsed.Scheme + "://" + parsed.Host
	if !s.allowedOrigins[origin] {
		return "", badRequest("redirect origin is not allowed")
	}
	return origin, nil
}

// createOAuthHandoff mints a one-time code that stands for the session the app
// has just been issued, so the token never travels in a URL.
func (s *Server) createOAuthHandoff(ctx context.Context, userID, deviceID string) (string, error) {
	code := auth.NewOpaqueToken()
	hash := auth.HashToken(code)
	if err := s.store.CreateOAuthCode(
		ctx, auth.NewID(auth.PrefixOAuthCode), userID, deviceID, hash, oauthHandoffTTL,
	); err != nil {
		return "", err
	}
	return code, nil
}

// redirectOAuthHandoff sends the browser back to the app, with the code on
// success and an error reason on failure.
func (s *Server) redirectOAuthHandoff(w http.ResponseWriter, r *http.Request, target, code, reason string) {
	params := url.Values{}
	if code != "" {
		params.Set("code", code)
	}
	if reason != "" {
		params.Set("error", reason)
	}

	var destination string
	if strings.EqualFold(target, oauthAppRedirect) {
		destination = oauthAppRedirect + "?" + params.Encode()
	} else {
		destination = target + "/sign-in?" + params.Encode()
	}
	http.Redirect(w, r, destination, http.StatusFound)
}

// oauthExchangeRequest is the POST /v1/auth/oauth/exchange body.
type oauthExchangeRequest struct {
	Code   string         `json:"code"`
	Device *deviceRequest `json:"device"`
}

// handleOAuthExchange trades a one-time handoff code for a session, which is how
// a native app turns a browser sign-in into its own bearer token.
func (s *Server) handleOAuthExchange(w http.ResponseWriter, r *http.Request) {
	var req oauthExchangeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, s.log, err)
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		writeError(w, s.log, badRequest("code is required"))
		return
	}

	handoff, err := s.store.ConsumeOAuthCode(r.Context(), auth.HashToken(code))
	if err != nil {
		if errors.Is(err, store.ErrOAuthCode) {
			writeError(w, s.log, unauthorized())
			return
		}
		writeError(w, s.log, err)
		return
	}

	user, err := s.store.UserByID(r.Context(), handoff.UserID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	device, err := s.store.DeviceByID(r.Context(), handoff.UserID, handoff.DeviceID)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	if _, err := s.store.EnsureStore(r.Context(), auth.NewID(auth.PrefixStore), user.ID); err != nil {
		writeError(w, s.log, err)
		return
	}

	_, token, err := s.startSession(r.Context(), user.ID, device.ID, r)
	if err != nil {
		writeError(w, s.log, err)
		return
	}

	s.log.Info("oauth handoff exchanged", "user", user.ID, "device", device.ID)
	writeData(w, http.StatusOK, authPayload{User: user, Token: token, Device: device})
}

// handleOAuthProviders reports which providers this server can complete, so a
// client hides a button instead of offering a sign-in that cannot finish.
func (s *Server) handleOAuthProviders(w http.ResponseWriter, r *http.Request) {
	configured := make(map[string]bool, len(s.providers))
	for name, provider := range s.providers {
		configured[name] = provider.credentials.Enabled()
	}
	writeData(w, http.StatusOK, configured)
}
