package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Session is one authenticated device session.
type Session struct {
	ID         string
	UserID     string
	DeviceID   string
	UserAgent  *string
	CreatedAt  time.Time
	LastUsedAt time.Time
	ExpiresAt  time.Time
}

// Auth is everything a request needs once its session is resolved.
type Auth struct {
	Session Session
	User    User
	Store   *StoreRecord
}

// CreateSession stores a session with only the SHA-256 hash of the token.
func (s *Store) CreateSession(
	ctx context.Context, id, userID, deviceID string, tokenHash []byte,
	userAgent *string, ttl time.Duration,
) (Session, error) {
	var (
		session  Session
		created  time.Time
		lastUsed time.Time
		expires  time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, device_id, token_hash, user_agent, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, user_id, device_id, user_agent, created_at, last_used_at, expires_at`,
		id, userID, deviceID, tokenHash, userAgent, s.now().Add(ttl),
	).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.UserAgent,
		&created, &lastUsed, &expires)
	if err != nil {
		return Session{}, fmt.Errorf("store: create session: %w", err)
	}
	session.CreatedAt = created
	session.LastUsedAt = lastUsed
	session.ExpiresAt = expires
	return session, nil
}

// AuthByTokenHash resolves a bearer or cookie token to its session, user and
// store. Expired, revoked, or device-revoked sessions all answer ErrNotFound, so
// the caller cannot learn which one it was.
func (s *Store) AuthByTokenHash(ctx context.Context, tokenHash []byte) (Auth, error) {
	var (
		auth      Auth
		userAgent *string
		sessionAt time.Time
		lastUsed  time.Time
		expiresAt time.Time
		name      *string
		avatarURL *string
		verified  *time.Time
		userAt    time.Time
		storeID   *string
		storeUser *string
		storeKind *string
		storeName *string
		storeVer  *int
		storeAt   *time.Time
	)

	err := s.pool.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.device_id, s.user_agent, s.created_at, s.last_used_at, s.expires_at,
		       u.id, u.email, u.name, u.avatar_url, u.email_verified_at, u.created_at,
		       st.id, st.user_id, st.kind, st.schema_name, st.schema_version, st.created_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		JOIN devices d ON d.id = s.device_id
		LEFT JOIN stores st ON st.user_id = u.id
		WHERE s.token_hash = $1
		  AND s.revoked_at IS NULL
		  AND s.expires_at > now()
		  AND d.revoked_at IS NULL
		  AND u.deleted_at IS NULL`, tokenHash,
	).Scan(
		&auth.Session.ID, &auth.Session.UserID, &auth.Session.DeviceID, &userAgent,
		&sessionAt, &lastUsed, &expiresAt,
		&auth.User.ID, &auth.User.Email, &name, &avatarURL, &verified, &userAt,
		&storeID, &storeUser, &storeKind, &storeName, &storeVer, &storeAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Auth{}, ErrNotFound
		}
		return Auth{}, fmt.Errorf("store: resolve session: %w", err)
	}

	auth.Session.UserAgent = userAgent
	auth.Session.CreatedAt = sessionAt
	auth.Session.LastUsedAt = lastUsed
	auth.Session.ExpiresAt = expiresAt
	auth.User.Name = name
	auth.User.AvatarURL = avatarURL
	auth.User.EmailVerifiedAt = asMillis(verified)
	auth.User.CreatedAt = FromTime(userAt)

	if storeID != nil && storeUser != nil && storeKind != nil && storeName != nil &&
		storeVer != nil && storeAt != nil {
		auth.Store = &StoreRecord{
			ID:            *storeID,
			UserID:        *storeUser,
			Kind:          *storeKind,
			SchemaName:    *storeName,
			SchemaVersion: *storeVer,
			CreatedAt:     FromTime(*storeAt),
		}
	}
	return auth, nil
}

// TouchSession records activity on a session.
func (s *Store) TouchSession(ctx context.Context, sessionID string) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE sessions SET last_used_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID,
	); err != nil {
		return fmt.Errorf("store: touch session: %w", err)
	}
	return nil
}

// RevokeSession revokes one session belonging to userID.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, sessionID, userID)
	if err != nil {
		return fmt.Errorf("store: revoke session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListSessions returns the caller's live sessions, newest first, marking the one
// that made the request.
func (s *Store) ListSessions(ctx context.Context, userID, currentSessionID string) ([]SessionInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.device_id, d.name, d.platform, s.created_at, s.last_used_at, s.expires_at
		FROM sessions s
		JOIN devices d ON d.id = s.device_id
		WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND d.revoked_at IS NULL
		ORDER BY s.last_used_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list sessions: %w", err)
	}
	defer rows.Close()

	out := make([]SessionInfo, 0, 4)
	for rows.Next() {
		var (
			info      SessionInfo
			created   time.Time
			lastUsed  time.Time
			expiresAt time.Time
		)
		if err := rows.Scan(&info.ID, &info.DeviceID, &info.DeviceName, &info.Platform,
			&created, &lastUsed, &expiresAt); err != nil {
			return nil, fmt.Errorf("store: scan session: %w", err)
		}
		info.CreatedAt = FromTime(created)
		info.LastUsedAt = FromTime(lastUsed)
		info.ExpiresAt = FromTime(expiresAt)
		info.Current = info.ID == currentSessionID
		out = append(out, info)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list sessions: %w", err)
	}
	return out, nil
}
