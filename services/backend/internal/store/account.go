package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ChangePassword stores a new argon2id hash and revokes every other session of
// the user in one transaction, so a leaked password stops working everywhere
// except the device that changed it.
func (s *Store) ChangePassword(
	ctx context.Context, userID, keepSessionID, passwordHash string,
) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("store: begin password change: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE users SET password_hash = $2 WHERE id = $1 AND deleted_at IS NULL`, userID, passwordHash)
	if err != nil {
		return 0, fmt.Errorf("store: change password: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrNotFound
	}

	revoked, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, userID, keepSessionID)
	if err != nil {
		return 0, fmt.Errorf("store: revoke other sessions: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("store: commit password change: %w", err)
	}
	return revoked.RowsAffected(), nil
}

// DeleteUser removes an account for good: the user's store schema with all of
// its content, then the user row, whose foreign keys cascade to accounts,
// devices, sessions, tokens, the store registry and ovens.
func (s *Store) DeleteUser(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin delete user: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialise against a concurrent provisioning of the same user.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "store:"+userID); err != nil {
		return fmt.Errorf("store: delete user lock: %w", err)
	}

	var schemaName string
	err = tx.QueryRow(ctx, `SELECT schema_name FROM stores WHERE user_id = $1`, userID).Scan(&schemaName)
	switch {
	case err == nil:
		if _, err := tx.Exec(ctx,
			`DROP SCHEMA IF EXISTS `+pgx.Identifier{schemaName}.Sanitize()+` CASCADE`,
		); err != nil {
			return fmt.Errorf("store: drop user store: %w", err)
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return fmt.Errorf("store: read user store: %w", err)
	}

	tag, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	if err != nil {
		return fmt.Errorf("store: delete user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit delete user: %w", err)
	}
	return nil
}
