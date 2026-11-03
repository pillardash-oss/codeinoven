package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// NewSchemaName returns a fresh store schema name: store_ plus 20 lower case hex
// characters (80 bits of randomness).
func NewSchemaName() string {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		panic("store: crypto/rand unavailable: " + err.Error())
	}
	return "store_" + hex.EncodeToString(buf)
}

// StoreStatus is the payload of GET /v1/store/status.
type StoreStatus struct {
	Kind            string `json:"kind"`
	SchemaVersion   int    `json:"schemaVersion"`
	RequiredVersion int    `json:"requiredVersion"`
	Migratable      bool   `json:"migratable"`
}

// StoreByUser returns the registry row for a user's store.
func (s *Store) StoreByUser(ctx context.Context, userID string) (StoreRecord, error) {
	var (
		rec     StoreRecord
		created time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, kind, schema_name, schema_version, created_at
		FROM stores WHERE user_id = $1`, userID,
	).Scan(&rec.ID, &rec.UserID, &rec.Kind, &rec.SchemaName, &rec.SchemaVersion, &created)
	if err != nil {
		return StoreRecord{}, mapNoRows(err)
	}
	rec.CreatedAt = FromTime(created)
	return rec, nil
}

// ProvisionStore creates a user's store schema, applies the store template to it
// and registers it. It is idempotent: an existing store is returned untouched.
func (s *Store) ProvisionStore(ctx context.Context, storeID, userID string) (StoreRecord, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StoreRecord{}, fmt.Errorf("store: begin provision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// One provisioning per user at a time, in or out of process.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "store:"+userID); err != nil {
		return StoreRecord{}, fmt.Errorf("store: provision lock: %w", err)
	}

	var (
		existing  StoreRecord
		createdAt time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, kind, schema_name, schema_version, created_at
		FROM stores WHERE user_id = $1`, userID,
	).Scan(&existing.ID, &existing.UserID, &existing.Kind, &existing.SchemaName,
		&existing.SchemaVersion, &createdAt)
	if err == nil {
		existing.CreatedAt = FromTime(createdAt)
		if err := tx.Commit(ctx); err != nil {
			return StoreRecord{}, fmt.Errorf("store: commit provision: %w", err)
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return StoreRecord{}, fmt.Errorf("store: lookup store: %w", err)
	}

	schemaName := NewSchemaName()
	if _, err := tx.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schemaName}.Sanitize()); err != nil {
		return StoreRecord{}, fmt.Errorf("store: create schema: %w", err)
	}

	if _, err := tx.Exec(ctx,
		"SET LOCAL search_path TO "+pgx.Identifier{schemaName}.Sanitize()+", public",
	); err != nil {
		return StoreRecord{}, fmt.Errorf("store: set store search_path: %w", err)
	}

	applied, err := applyMigrations(ctx, tx, StoreMigrations)
	if err != nil {
		return StoreRecord{}, err
	}

	rec := StoreRecord{
		ID:            storeID,
		UserID:        userID,
		Kind:          "hosted",
		SchemaName:    schemaName,
		SchemaVersion: RequiredStoreVersion(),
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO public.stores (id, user_id, kind, schema_name, schema_version)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`,
		rec.ID, rec.UserID, rec.Kind, rec.SchemaName, rec.SchemaVersion,
	).Scan(&createdAt); err != nil {
		return StoreRecord{}, fmt.Errorf("store: register store: %w", err)
	}
	rec.CreatedAt = FromTime(createdAt)

	if err := tx.Commit(ctx); err != nil {
		return StoreRecord{}, fmt.Errorf("store: commit provision: %w", err)
	}

	s.log.Info("store provisioned",
		"user", userID, "schema", schemaName, "version", rec.SchemaVersion, "migrations", applied)
	return rec, nil
}

// EnsureStore returns the user's store, provisioning it when it is missing.
func (s *Store) EnsureStore(ctx context.Context, storeID, userID string) (StoreRecord, error) {
	rec, err := s.StoreByUser(ctx, userID)
	if err == nil {
		return rec, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return StoreRecord{}, err
	}
	return s.ProvisionStore(ctx, storeID, userID)
}

// StoreStatus reports how far a user's store schema has been migrated.
func (s *Store) StoreStatus(ctx context.Context, rec StoreRecord) (StoreStatus, error) {
	var applied int
	err := s.withSchema(ctx, rec.SchemaName, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&applied)
	})
	if err != nil {
		return StoreStatus{}, fmt.Errorf("store: store status: %w", err)
	}

	required := RequiredStoreVersion()
	return StoreStatus{
		Kind:            rec.Kind,
		SchemaVersion:   applied,
		RequiredVersion: required,
		Migratable:      applied < required,
	}, nil
}

// ReplaceContent empties a user's content tables and runs write in the same
// transaction. It exists for cmd/seed, which has to be re-runnable.
func (s *Store) ReplaceContent(
	ctx context.Context, schemaName string, write func(tx pgx.Tx) error,
) error {
	return s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `TRUNCATE messages, prompts, threads, projects`); err != nil {
			return fmt.Errorf("store: truncate content: %w", err)
		}
		return write(tx)
	})
}
