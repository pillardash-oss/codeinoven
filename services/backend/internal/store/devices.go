package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// CreateDevice records a device for a user. Devices are named by the client; the
// platform is one of desktop, ios, android.
func (s *Store) CreateDevice(ctx context.Context, id, userID, name, platform string) (Device, error) {
	var (
		device     Device
		created    time.Time
		lastSeenAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO devices (id, user_id, name, platform)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, platform, last_seen_at, created_at`,
		id, userID, name, platform,
	).Scan(&device.ID, &device.Name, &device.Platform, &lastSeenAt, &created)
	if err != nil {
		return Device{}, fmt.Errorf("store: create device: %w", err)
	}
	device.LastSeenAt = FromTime(lastSeenAt)
	device.CreatedAt = FromTime(created)
	return device, nil
}

// ListDevices returns every device on the account, newest first.
func (s *Store) ListDevices(ctx context.Context, userID, currentDeviceID string) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, platform, last_seen_at, created_at
		FROM devices
		WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list devices: %w", err)
	}
	defer rows.Close()

	out := make([]Device, 0, 4)
	for rows.Next() {
		var (
			device     Device
			lastSeenAt time.Time
			created    time.Time
		)
		if err := rows.Scan(&device.ID, &device.Name, &device.Platform, &lastSeenAt,
			&created); err != nil {
			return nil, fmt.Errorf("store: scan device: %w", err)
		}
		device.LastSeenAt = FromTime(lastSeenAt)
		device.CreatedAt = FromTime(created)
		device.Current = device.ID == currentDeviceID
		out = append(out, device)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list devices: %w", err)
	}
	return out, nil
}

// FindDevice returns the user's live device with that name and platform, so a
// repeated sign-in from the same machine reuses its row instead of adding one.
func (s *Store) FindDevice(ctx context.Context, userID, name, platform string) (Device, error) {
	var (
		device     Device
		created    time.Time
		lastSeenAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, platform, last_seen_at, created_at
		FROM devices
		WHERE user_id = $1 AND name = $2 AND platform = $3 AND revoked_at IS NULL
		ORDER BY created_at DESC
		LIMIT 1`, userID, name, platform,
	).Scan(&device.ID, &device.Name, &device.Platform, &lastSeenAt, &created)
	if err != nil {
		return Device{}, mapNoRows(err)
	}
	device.LastSeenAt = FromTime(lastSeenAt)
	device.CreatedAt = FromTime(created)
	return device, nil
}

// TouchDevice records that a device is still in use.
func (s *Store) TouchDevice(ctx context.Context, deviceID string) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE devices SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL`, deviceID,
	); err != nil {
		return fmt.Errorf("store: touch device: %w", err)
	}
	return nil
}

// RevokeDevice revokes a device and every session it holds.
func (s *Store) RevokeDevice(ctx context.Context, userID, deviceID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin revoke device: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE devices SET revoked_at = now()
		WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, deviceID, userID)
	if err != nil {
		return fmt.Errorf("store: revoke device: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE device_id = $1 AND revoked_at IS NULL`, deviceID); err != nil {
		return fmt.Errorf("store: revoke device sessions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit revoke device: %w", err)
	}
	return nil
}

// DeviceExists reports whether a live device with that id belongs to the user.
func (s *Store) DeviceExists(ctx context.Context, userID, deviceID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
		)`, deviceID, userID).Scan(&exists)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("store: device exists: %w", err)
	}
	return exists, nil
}

// DeviceByID returns one live device owned by the user.
func (s *Store) DeviceByID(ctx context.Context, userID, deviceID string) (Device, error) {
	var (
		device    Device
		lastSeen  time.Time
		createdAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, platform, last_seen_at, created_at
		FROM devices
		WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, deviceID, userID,
	).Scan(&device.ID, &device.Name, &device.Platform, &lastSeen, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, fmt.Errorf("store: device by id: %w", err)
	}
	device.LastSeenAt = FromTime(lastSeen)
	device.CreatedAt = FromTime(createdAt)
	return device, nil
}
