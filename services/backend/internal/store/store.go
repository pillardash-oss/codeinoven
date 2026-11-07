// Package store owns every SQL statement the service runs.
//
// The control plane lives in `public`. Each user's content lives in its own
// schema named store_<20 hex characters>, and every content query runs inside a
// transaction that first executes
//
//	SET LOCAL search_path TO "<schema>", public
//
// so unqualified table names resolve to that user's store and nothing else.
package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors the HTTP layer maps to status codes.
var (
	// ErrNotFound means the row does not exist (or is not visible to this user).
	ErrNotFound = errors.New("store: not found")
	// ErrConflict means the row exists but its state forbids the change, such as
	// a prompt an Oven has already claimed.
	ErrConflict = errors.New("store: conflict")
	// ErrEmailTaken means another account already uses that address.
	ErrEmailTaken = errors.New("store: email already registered")
	// ErrTokenInvalid means a single-use token is unknown, used or expired.
	ErrTokenInvalid = errors.New("store: token invalid or expired")
	// ErrChecksumMismatch means a migration file changed after it was applied.
	ErrChecksumMismatch = errors.New("store: migration checksum mismatch")
	// ErrAttachmentInvalid means an attachment id a caller named is unknown, belongs
	// to another thread, or is already carried by a prompt. The request is wrong,
	// not the resource's state, so the HTTP layer answers 400 rather than 409.
	ErrAttachmentInvalid = errors.New("store: attachment is not available for this prompt")
)

// schemaNamePattern is the only shape a store schema name may take. It is
// checked before any name is interpolated into SQL.
var schemaNamePattern = regexp.MustCompile(`^store_[a-f0-9]{20}$`)

// ValidSchemaName reports whether name is a store schema this service created.
func ValidSchemaName(name string) bool {
	return schemaNamePattern.MatchString(name)
}

// Store wraps the Postgres pool.
type Store struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	now  func() time.Time
}

// Open connects to Postgres. It does not ping: the caller decides when a failed
// database should stop startup.
func Open(ctx context.Context, dsn string, logger *slog.Logger) (*Store, error) {
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("store: parse DATABASE_URL: %w", err)
	}

	// Content queries depend on `SET LOCAL search_path`, and pgx's statement
	// cache is keyed by SQL text alone. A statement prepared under one user's
	// search_path would be reused for another user's schema, so execute
	// statements uncached (described per execution) instead.
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	// Control-plane queries are unqualified, so pin them to public. Content
	// queries override this per transaction with SET LOCAL search_path.
	poolConfig.ConnConfig.RuntimeParams["search_path"] = "public"
	poolConfig.MaxConns = 10
	poolConfig.MinConns = 1
	poolConfig.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}

	return &Store{pool: pool, log: logger, now: time.Now}, nil
}

// Close releases the pool.
func (s *Store) Close() {
	s.pool.Close()
}

// Ping checks that Postgres answers.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// Now is the store's clock, injectable in tests.
func (s *Store) Now() time.Time {
	return s.now()
}

// Pool exposes the pool to the migration runner only.
func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}

// withSchema runs fn inside a transaction whose search_path is the user's store
// schema followed by public. The schema name is validated before it is quoted.
func (s *Store) withSchema(ctx context.Context, schemaName string, fn func(pgx.Tx) error) error {
	if !ValidSchemaName(schemaName) {
		return fmt.Errorf("store: refusing to use invalid schema name %q", schemaName)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer func() {
		// Rollback after a successful commit is a no-op error, ignored on purpose.
		_ = tx.Rollback(ctx)
	}()

	setPath := "SET LOCAL search_path TO " + pgx.Identifier{schemaName}.Sanitize() + ", public"
	if _, err := tx.Exec(ctx, setPath); err != nil {
		return fmt.Errorf("store: set search_path: %w", err)
	}

	if err := fn(tx); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}

// isUniqueViolation reports whether err is a Postgres unique violation.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// mapNoRows turns pgx.ErrNoRows into ErrNotFound.
func mapNoRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
