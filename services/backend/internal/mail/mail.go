// Package mail sends the links the account system needs.
//
// There is exactly one implementation: a development sender that writes the
// link to the structured log. A real transactional provider is not wired yet, so
// New refuses to hand back a sender outside development rather than silently
// accepting mail that will never arrive.
package mail

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// Sender delivers the two transactional messages the backend has today.
type Sender interface {
	SendVerification(ctx context.Context, to, name, link string) error
	SendPasswordReset(ctx context.Context, to, name, link string) error
}

// New returns the mail sender for the environment.
//
// In development it returns a logging sender. Anywhere else it fails with an
// explanatory error, because email sign-up is enabled and no provider is
// configured yet: starting would accept sign-ups whose verification link has
// nowhere to go.
func New(environment string, logger *slog.Logger) (Sender, error) {
	if strings.EqualFold(environment, "development") {
		return &devSender{logger: logger}, nil
	}
	return nil, errors.New(
		"no mail sender configured: email sign-up is enabled but no transactional provider is wired " +
			"(internal/mail). Refusing to start outside development because verification and reset links " +
			"could not be delivered",
	)
}

// devSender logs links instead of delivering them.
type devSender struct {
	logger *slog.Logger
}

func (s *devSender) SendVerification(_ context.Context, to, name, link string) error {
	s.logger.Info("development mail: email verification link",
		"to", to,
		"name", name,
		"link", link,
	)
	return nil
}

func (s *devSender) SendPasswordReset(_ context.Context, to, name, link string) error {
	s.logger.Info("development mail: password reset link",
		"to", to,
		"name", name,
		"link", link,
	)
	return nil
}

// Link builds an absolute link against the service's own public origin.
func Link(baseURL, path, token string) string {
	return fmt.Sprintf("%s%s?token=%s", strings.TrimRight(baseURL, "/"), path, token)
}
