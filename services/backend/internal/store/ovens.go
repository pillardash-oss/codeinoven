package store

import (
	"context"
	"fmt"
	"time"
)

// UpsertOven records a heartbeat for the user's Oven, creating it on first sight.
// The fingerprint is what identifies a machine: it is stable across restarts, so
// a heartbeat for a known fingerprint updates the row instead of adding one.
func (s *Store) UpsertOven(
	ctx context.Context, id, userID, name, fingerprint string, descriptor JSON,
) (Oven, error) {
	if len(descriptor) == 0 {
		descriptor = JSON("{}")
	}

	var (
		oven      Oven
		heartbeat time.Time
	)
	var rawDescriptor []byte
	err := s.pool.QueryRow(ctx, `
		INSERT INTO ovens (id, user_id, name, fingerprint, descriptor, last_heartbeat_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, now())
		ON CONFLICT (user_id, fingerprint) DO UPDATE
		SET name = EXCLUDED.name,
		    descriptor = EXCLUDED.descriptor,
		    last_heartbeat_at = now()
		RETURNING id, name, fingerprint, last_heartbeat_at, descriptor`,
		id, userID, name, fingerprint, string(descriptor),
	).Scan(&oven.ID, &oven.Name, &oven.Fingerprint, &heartbeat, &rawDescriptor)
	if err != nil {
		return Oven{}, fmt.Errorf("store: upsert oven: %w", err)
	}
	oven.Descriptor = JSON(rawDescriptor)
	oven.LastHeartbeatAt = FromTime(heartbeat)
	return oven, nil
}

// ListOvens returns the user's Ovens, most recently seen first.
func (s *Store) ListOvens(ctx context.Context, userID string) ([]Oven, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, fingerprint, last_heartbeat_at, descriptor
		FROM ovens
		WHERE user_id = $1
		ORDER BY last_heartbeat_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list ovens: %w", err)
	}
	defer rows.Close()

	out := make([]Oven, 0, 2)
	for rows.Next() {
		var (
			oven      Oven
			heartbeat time.Time
		)
		var rawDescriptor []byte
		if err := rows.Scan(&oven.ID, &oven.Name, &oven.Fingerprint, &heartbeat,
			&rawDescriptor); err != nil {
			return nil, fmt.Errorf("store: scan oven: %w", err)
		}
		oven.Descriptor = JSON(rawDescriptor)
		oven.LastHeartbeatAt = FromTime(heartbeat)
		out = append(out, oven)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list ovens: %w", err)
	}
	return out, nil
}
