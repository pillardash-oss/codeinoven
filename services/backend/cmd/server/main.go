// Command server is the CodeInOven backend.
//
// It is wiring only: configuration, the Postgres pool, migrations, the router,
// and a graceful shutdown on a signal. Every behaviour lives in internal/.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/config"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/httpapi"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/logging"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/mail"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		// slog is the only logger, including here.
		slog.Error("server stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		logging.New("development").Error("configuration is not valid", "error", err.Error())
		return err
	}

	logger := logging.New(cfg.Environment)
	logger.Info("starting codeinoven backend",
		"addr", cfg.HTTPAddr,
		"environment", cfg.Environment,
		"public_base_url", cfg.PublicBaseURL,
		"session_ttl", cfg.SessionTTL.String(),
		"google_sign_in", cfg.Google.Enabled(),
		"github_sign_in", cfg.GitHub.Enabled(),
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startupCtx, cancelStartup := context.WithTimeout(ctx, 60*time.Second)
	defer cancelStartup()

	database, err := store.Open(startupCtx, cfg.DatabaseURL, logger)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := database.Ping(startupCtx); err != nil {
		return fmt.Errorf("database is not reachable: %w", err)
	}

	if err := database.MigrateControl(startupCtx); err != nil {
		return err
	}
	if err := database.MigrateAllStores(startupCtx); err != nil {
		return err
	}

	sender, err := mail.New(cfg.Environment, logger)
	if err != nil {
		return err
	}

	server := httpapi.New(httpapi.Options{
		Config: cfg,
		Store:  database,
		Logger: logger,
		Mail:   sender,
	})

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	listenErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
			return
		}
		listenErr <- nil
	}()

	select {
	case err := <-listenErr:
		if err != nil {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("shutdown requested")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelShutdown()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("stopped")
	return nil
}
