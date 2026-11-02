package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/pillardash-oss/codeinoven/services/backend/migrations"
)

// Migration scopes: embedded directories under migrations/.
const (
	ControlMigrations = "control"
	StoreMigrations   = "store"
)

// migration is one embedded .sql file.
type migration struct {
	version  string
	checksum string
	body     string
}

// loadMigrations reads and orders every .sql file in a scope.
func loadMigrations(scope string) ([]migration, error) {
	entries, err := fs.ReadDir(migrations.FS, scope)
	if err != nil {
		return nil, fmt.Errorf("store: read migrations %q: %w", scope, err)
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		names = append(names, entry.Name())
	}
	// Lexical order is the migration order: files are named 0001_..., 0002_...
	sort.Strings(names)

	out := make([]migration, 0, len(names))
	for _, name := range names {
		body, err := fs.ReadFile(migrations.FS, path.Join(scope, name))
		if err != nil {
			return nil, fmt.Errorf("store: read migration %s/%s: %w", scope, name, err)
		}
		sum := sha256.Sum256(body)
		out = append(out, migration{
			version:  strings.TrimSuffix(name, ".sql"),
			checksum: hex.EncodeToString(sum[:]),
			body:     string(body),
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("store: no migrations embedded for %q", scope)
	}
	return out, nil
}

// RequiredStoreVersion is how many store migrations this binary carries. A user
// store is up to date when its schema_migrations holds that many rows.
func RequiredStoreVersion() int {
	files, err := loadMigrations(StoreMigrations)
	if err != nil {
		return 0
	}
	return len(files)
}

// applyMigrations runs every unapplied migration in scope inside tx, recording
// its version and checksum. It refuses to continue when a recorded checksum
// differs from the file, because that means a migration was edited after it was
// applied. Migrations are forward only: there is no down path.
//
// tx must already have the search_path that points schema_migrations at the
// right schema: `public` for the control plane, the user's store schema
// otherwise.
func applyMigrations(ctx context.Context, tx pgx.Tx, scope string) ([]string, error) {
	files, err := loadMigrations(scope)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			checksum   text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return nil, fmt.Errorf("store: create schema_migrations: %w", err)
	}

	applied := make(map[string]string, len(files))
	rows, err := tx.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("store: read schema_migrations: %w", err)
	}
	for rows.Next() {
		var version, checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			rows.Close()
			return nil, fmt.Errorf("store: scan schema_migrations: %w", err)
		}
		applied[version] = checksum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read schema_migrations: %w", err)
	}

	appliedNow := make([]string, 0, len(files))
	for _, file := range files {
		if recorded, ok := applied[file.version]; ok {
			if recorded != file.checksum {
				return nil, fmt.Errorf(
					"%w: %s/%s recorded %s but the file hashes to %s",
					ErrChecksumMismatch, scope, file.version, recorded, file.checksum,
				)
			}
			continue
		}

		if _, err := tx.Exec(ctx, file.body); err != nil {
			return nil, fmt.Errorf("store: apply %s/%s: %w", scope, file.version, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
			file.version, file.checksum,
		); err != nil {
			return nil, fmt.Errorf("store: record %s/%s: %w", scope, file.version, err)
		}
		appliedNow = append(appliedNow, file.version)
	}
	return appliedNow, nil
}

// MigrateControl applies the control plane migrations to `public`.
func (s *Store) MigrateControl(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin control migration: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SET LOCAL search_path TO public"); err != nil {
		return fmt.Errorf("store: set control search_path: %w", err)
	}

	applied, err := applyMigrations(ctx, tx, ControlMigrations)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit control migration: %w", err)
	}

	for _, version := range applied {
		s.log.Info("migration applied", "scope", ControlMigrations, "version", version)
	}
	return nil
}

// MigrateAllStores brings every provisioned user store up to the template the
// binary carries, so a store schema change rolls out with a server restart.
func (s *Store) MigrateAllStores(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id, schema_name FROM stores ORDER BY created_at`)
	if err != nil {
		return fmt.Errorf("store: list stores: %w", err)
	}
	type target struct{ id, schema string }
	targets := make([]target, 0, 8)
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.schema); err != nil {
			rows.Close()
			return fmt.Errorf("store: scan store: %w", err)
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("store: list stores: %w", err)
	}

	for _, t := range targets {
		if err := s.migrateStore(ctx, t.schema); err != nil {
			return fmt.Errorf("store: migrate %s: %w", t.schema, err)
		}
	}
	return nil
}

// migrateStore applies the store template inside one schema and records the new
// version on the registry row.
func (s *Store) migrateStore(ctx context.Context, schemaName string) error {
	if !ValidSchemaName(schemaName) {
		return fmt.Errorf("store: refusing to migrate invalid schema name %q", schemaName)
	}

	var applied []string
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		applied, err = applyMigrations(ctx, tx, StoreMigrations)
		return err
	})
	if err != nil {
		return err
	}

	required := RequiredStoreVersion()
	if _, err := s.pool.Exec(ctx,
		`UPDATE public.stores SET schema_version = $2 WHERE schema_name = $1`,
		schemaName, required,
	); err != nil {
		return fmt.Errorf("store: record store version: %w", err)
	}

	for _, version := range applied {
		s.log.Info("migration applied", "scope", StoreMigrations, "schema", schemaName, "version", version)
	}
	return nil
}
