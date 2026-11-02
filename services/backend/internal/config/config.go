// Package config reads the service's configuration from the environment.
//
// There is deliberately no .env loader: the caller (bun in development, the
// process manager in production) provides the environment. Defaults exist only
// where a value is safe for local development.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// DefaultSessionSecret is used outside production when SESSION_SECRET is absent.
// It is refused in production.
const DefaultSessionSecret = "development-only-session-secret"

// DefaultDatabaseURL points at the database scripts/db-setup.sh creates.
const DefaultDatabaseURL = "postgres://localhost:5432/codeinoven_dev?sslmode=disable"

// OAuth holds one provider's client credentials.
type OAuth struct {
	ClientID     string
	ClientSecret string
}

// Enabled reports whether both halves of the provider's credentials are present.
func (o OAuth) Enabled() bool {
	return o.ClientID != "" && o.ClientSecret != ""
}

// Config is the full runtime configuration.
type Config struct {
	HTTPAddr      string
	DatabaseURL   string
	PublicBaseURL string
	AppOrigins    []string
	SessionTTL    time.Duration
	SessionSecret string
	Environment   string
	Google        OAuth
	GitHub        OAuth
}

// IsDevelopment reports whether the service runs in development mode.
func (c Config) IsDevelopment() bool {
	return strings.EqualFold(c.Environment, "development")
}

// Load reads the environment and validates it.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:      envOr("HTTP_ADDR", "127.0.0.1:8080"),
		DatabaseURL:   envOr("DATABASE_URL", DefaultDatabaseURL),
		PublicBaseURL: strings.TrimRight(envOr("PUBLIC_BASE_URL", "http://127.0.0.1:8080"), "/"),
		AppOrigins:    splitList(osEnv("APP_ORIGINS")),
		SessionSecret: envOr("SESSION_SECRET", DefaultSessionSecret),
		Environment:   envOr("ENVIRONMENT", "development"),
		Google: OAuth{
			ClientID:     osEnv("GOOGLE_CLIENT_ID"),
			ClientSecret: osEnv("GOOGLE_CLIENT_SECRET"),
		},
		GitHub: OAuth{
			ClientID:     osEnv("GITHUB_CLIENT_ID"),
			ClientSecret: osEnv("GITHUB_CLIENT_SECRET"),
		},
	}

	ttl, err := time.ParseDuration(envOr("SESSION_TTL", "720h"))
	if err != nil {
		return Config{}, fmt.Errorf("SESSION_TTL: %w", err)
	}
	if ttl <= 0 {
		return Config{}, errors.New("SESSION_TTL must be positive")
	}
	cfg.SessionTTL = ttl

	if _, err := url.Parse(cfg.PublicBaseURL); err != nil {
		return Config{}, fmt.Errorf("PUBLIC_BASE_URL: %w", err)
	}
	if !strings.HasPrefix(cfg.PublicBaseURL, "http://") && !strings.HasPrefix(cfg.PublicBaseURL, "https://") {
		return Config{}, fmt.Errorf("PUBLIC_BASE_URL must start with http:// or https://, got %q", cfg.PublicBaseURL)
	}

	if !cfg.IsDevelopment() {
		if cfg.SessionSecret == DefaultSessionSecret || len(cfg.SessionSecret) < 32 {
			return Config{}, errors.New("SESSION_SECRET must be set to at least 32 characters outside development")
		}
	}

	return cfg, nil
}
