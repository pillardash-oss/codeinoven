// Package logging builds the service's structured logger.
//
// log/slog only: JSON in every environment, level derived from ENVIRONMENT.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// New returns a JSON slog logger for the given environment and installs it as
// the process default, so libraries that call slog.Default() agree with it.
func New(environment string) *slog.Logger {
	level := slog.LevelInfo
	if strings.EqualFold(environment, "development") {
		level = slog.LevelDebug
	}

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger
}
