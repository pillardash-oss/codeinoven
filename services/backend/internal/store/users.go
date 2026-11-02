package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// userColumns is the scan order used by every user query.
const userColumns = `id, email, name, avatar_url, email_verified_at, created_at`

// normaliseEmail lower cases and trims an address so the unique index on
// lower(email) is the only case rule in play.
func normaliseEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// scanUser reads one user row in userColumns order.
func scanUser(row pgx.Row) (User, error) {
	var (
		user     User
		name     *string
		avatar   *string
		verified *time.Time
		created  time.Time
	)
	if err := row.Scan(&user.ID, &user.Email, &name, &avatar, &verified, &created); err != nil {
		return User{}, mapNoRows(err)
	}
	user.Name = name
	user.AvatarURL = avatar
	user.EmailVerifiedAt = asMillis(verified)
	user.CreatedAt = FromTime(created)
	return user, nil
}

// CreateUser inserts an account. The address is stored lower cased; a duplicate
// returns ErrEmailTaken.
func (s *Store) CreateUser(ctx context.Context, id, email string, name *string) (User, error) {
	user, err := scanUser(s.pool.QueryRow(ctx, `
		INSERT INTO users (id, email, name)
		VALUES ($1, $2, $3)
		RETURNING `+userColumns,
		id, normaliseEmail(email), name,
	))
	if err != nil && isUniqueViolation(err) {
		return User{}, ErrEmailTaken
	}
	if err != nil {
		return User{}, fmt.Errorf("store: create user: %w", err)
	}
	return user, nil
}

// UserByID returns one account.
func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	user, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = $1 AND deleted_at IS NULL`, id,
	))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrNotFound
		}
		return User{}, fmt.Errorf("store: user by id: %w", err)
	}
	return user, nil
}

// UserByEmail returns one account by case insensitive address.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	user, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
		normaliseEmail(email),
	))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrNotFound
		}
		return User{}, fmt.Errorf("store: user by email: %w", err)
	}
	return user, nil
}

// MarkEmailVerified flags the address as verified and returns the user.
func (s *Store) MarkEmailVerified(ctx context.Context, userID string, at time.Time) (User, error) {
	user, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING `+userColumns, userID, at,
	))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrNotFound
		}
		return User{}, fmt.Errorf("store: mark email verified: %w", err)
	}
	return user, nil
}

// SetUserName updates the display name.
func (s *Store) SetUserName(ctx context.Context, userID string, name *string) (User, error) {
	user, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET name = $2 WHERE id = $1 AND deleted_at IS NULL
		RETURNING `+userColumns, userID, name,
	))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrNotFound
		}
		return User{}, fmt.Errorf("store: set user name: %w", err)
	}
	return user, nil
}

// SetUserAvatar stores an avatar URL without clobbering an existing one.
func (s *Store) SetUserAvatar(ctx context.Context, userID, avatarURL string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE users SET avatar_url = COALESCE(avatar_url, $2)
		WHERE id = $1 AND deleted_at IS NULL`, userID, avatarURL,
	); err != nil {
		return fmt.Errorf("store: set user avatar: %w", err)
	}
	return nil
}

// PasswordHash returns the argon2id hash for an account.
func (s *Store) PasswordHash(ctx context.Context, userID string) (string, error) {
	var hash *string
	if err := s.pool.QueryRow(ctx,
		`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, userID,
	).Scan(&hash); err != nil {
		return "", mapNoRows(err)
	}
	if hash == nil {
		return "", ErrNotFound
	}
	return *hash, nil
}

// UpdatePasswordHash stores a new argon2id hash.
func (s *Store) UpdatePasswordHash(ctx context.Context, userID, hash string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET password_hash = $2 WHERE id = $1 AND deleted_at IS NULL`, userID, hash)
	if err != nil {
		return fmt.Errorf("store: update password: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateEmailToken records a single-use verify or reset token, invalidating any
// outstanding token of the same kind for that user.
func (s *Store) CreateEmailToken(
	ctx context.Context, id, userID, kind string, tokenHash []byte, expiresAt time.Time,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin email token: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE email_tokens SET used_at = now()
		WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, userID, kind,
	); err != nil {
		return fmt.Errorf("store: retire email tokens: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO email_tokens (id, user_id, kind, token_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5)`, id, userID, kind, tokenHash, expiresAt,
	); err != nil {
		return fmt.Errorf("store: create email token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit email token: %w", err)
	}
	return nil
}

// ConsumeEmailToken marks a single-use token used and returns its user. Unknown,
// already used and expired tokens all answer ErrTokenInvalid.
func (s *Store) ConsumeEmailToken(ctx context.Context, tokenHash []byte, kind string) (string, error) {
	var userID string
	err := s.pool.QueryRow(ctx, `
		UPDATE email_tokens SET used_at = now()
		WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id`, tokenHash, kind,
	).Scan(&userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrTokenInvalid
		}
		return "", fmt.Errorf("store: consume email token: %w", err)
	}
	return userID, nil
}

// ResetPassword consumes a reset token, replaces the password hash and revokes
// every session in one transaction.
func (s *Store) ResetPassword(
	ctx context.Context, tokenHash []byte, passwordHash string,
) (string, int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", 0, fmt.Errorf("store: begin password reset: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var userID string
	if err := tx.QueryRow(ctx, `
		UPDATE email_tokens SET used_at = now()
		WHERE token_hash = $1 AND kind = 'reset' AND used_at IS NULL AND expires_at > now()
		RETURNING user_id`, tokenHash,
	).Scan(&userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, ErrTokenInvalid
		}
		return "", 0, fmt.Errorf("store: consume reset token: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE users SET password_hash = $2 WHERE id = $1`, userID, passwordHash,
	); err != nil {
		return "", 0, fmt.Errorf("store: set password: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	if err != nil {
		return "", 0, fmt.Errorf("store: revoke sessions: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", 0, fmt.Errorf("store: commit password reset: %w", err)
	}
	return userID, tag.RowsAffected(), nil
}

// AccountUserID returns the user an OAuth identity is already linked to.
func (s *Store) AccountUserID(
	ctx context.Context, provider, providerAccountID string,
) (string, error) {
	var userID string
	err := s.pool.QueryRow(ctx, `
		SELECT user_id FROM accounts WHERE provider = $1 AND provider_account_id = $2`,
		provider, providerAccountID,
	).Scan(&userID)
	if err != nil {
		return "", mapNoRows(err)
	}
	return userID, nil
}

// LinkAccount records an OAuth identity for a user.
func (s *Store) LinkAccount(ctx context.Context, id, userID, provider, providerAccountID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO accounts (id, user_id, provider, provider_account_id)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (provider, provider_account_id) DO NOTHING`,
		id, userID, provider, providerAccountID,
	)
	if err != nil {
		return fmt.Errorf("store: link account: %w", err)
	}
	return nil
}
