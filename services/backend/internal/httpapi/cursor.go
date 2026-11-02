package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// cursorPayload is the decoded form of an opaque cursor. Sort is recorded so a
// cursor from one ordering cannot be replayed against another.
type cursorPayload struct {
	Sort   string `json:"s"`
	Number int64  `json:"n,omitempty"`
	Name   string `json:"m,omitempty"`
	Flag   bool   `json:"p,omitempty"`
	ID     string `json:"i"`
}

// errInvalidCursor is returned for any cursor that cannot be trusted.
var errInvalidCursor = errors.New("cursor is invalid")

// encodeCursor turns a store cursor into the opaque string a caller echoes back.
func encodeCursor(cursor store.Cursor) string {
	payload := cursorPayload{
		Sort:   cursor.Sort,
		Number: cursor.Number,
		Name:   cursor.Name,
		Flag:   cursor.Flag,
		ID:     cursor.ID,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		// The payload is built from plain fields only; marshalling cannot fail.
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeCursor parses a cursor and checks it belongs to the requested ordering.
func decodeCursor(raw, sort string) (store.Cursor, error) {
	if raw == "" {
		return store.Cursor{}, errInvalidCursor
	}

	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return store.Cursor{}, errInvalidCursor
	}

	var payload cursorPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return store.Cursor{}, errInvalidCursor
	}
	if payload.ID == "" || payload.Sort != sort {
		return store.Cursor{}, errInvalidCursor
	}

	return store.Cursor{
		Sort:   payload.Sort,
		Number: payload.Number,
		Name:   payload.Name,
		Flag:   payload.Flag,
		ID:     payload.ID,
	}, nil
}
