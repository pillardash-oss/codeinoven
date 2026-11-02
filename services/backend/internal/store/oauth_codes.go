package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrOAuthCode reports a handoff code that is unknown, expired or already used.
var ErrOAuthCode = errors.New("store: oauth code is not usable")

// OAuthHandoff is the account and device a one-time code stands for.
type OAuthHandoff struct {
	UserID   string
	DeviceID string
}

// CreateOAuthCode stores the hash of a one-time handoff code.
func (s *Store) CreateOAuthCode(
	ctx context.Context, id, userID, deviceID string, codeHash []byte, ttl time.Duration,
) error {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO oauth_codes (id, user_id, device_id, code_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		id, userID, deviceID, codeHash, time.Now().Add(ttl),
	); err != nil {
		return fmt.Errorf("store: create oauth code: %w", err)
	}
	return nil
}

// ConsumeOAuthCode atomically marks a code used and returns what it stands for.
// A second call with the same code finds nothing, which is the point.
func (s *Store) ConsumeOAuthCode(ctx context.Context, codeHash []byte) (OAuthHandoff, error) {
	var handoff OAuthHandoff
	err := s.pool.QueryRow(ctx, `
		UPDATE oauth_codes
		SET used_at = now()
		WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id, device_id`, codeHash,
	).Scan(&handoff.UserID, &handoff.DeviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return OAuthHandoff{}, ErrOAuthCode
	}
	if err != nil {
		return OAuthHandoff{}, fmt.Errorf("store: consume oauth code: %w", err)
	}
	return handoff, nil
}
