package store

import (
	"strconv"
	"time"
)

// Millis is a UTC timestamp serialised as epoch milliseconds.
//
// The contract requires epoch milliseconds everywhere, and the desktop's own
// types are already in that unit, so a mirrored row needs no conversion.
type Millis int64

// FromTime converts a time to epoch milliseconds.
func FromTime(t time.Time) Millis {
	return Millis(t.UTC().UnixMilli())
}

// Time converts back to a time in UTC.
func (m Millis) Time() time.Time {
	return time.UnixMilli(int64(m)).UTC()
}

// asMillis returns a pointer to a Millis for nullable time columns.
func asMillis(t *time.Time) *Millis {
	if t == nil {
		return nil
	}
	m := FromTime(*t)
	return &m
}

// DTOs below carry the API's own JSON field names. They are the single source of
// truth for the payload shapes in services/README.md; there is no second mapping
// layer between the store and the HTTP handler.

// User is one account. Name and AvatarURL are nullable in the contract.
type User struct {
	ID              string  `json:"id"`
	Email           string  `json:"email"`
	Name            *string `json:"name"`
	AvatarURL       *string `json:"avatarUrl"`
	EmailVerifiedAt *Millis `json:"emailVerifiedAt"`
	CreatedAt       Millis  `json:"createdAt"`
}

// Device is one client the account signed in from.
type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	LastSeenAt Millis `json:"lastSeenAt"`
	CreatedAt  Millis `json:"createdAt"`
	Current    bool   `json:"current"`
}

// SessionInfo is one row of GET /v1/auth/sessions.
type SessionInfo struct {
	ID         string `json:"id"`
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
	CreatedAt  Millis `json:"createdAt"`
	LastUsedAt Millis `json:"lastUsedAt"`
	ExpiresAt  Millis `json:"expiresAt"`
	Current    bool   `json:"current"`
}

// StoreRecord is the registry row pointing at one user's content schema.
type StoreRecord struct {
	ID            string `json:"id"`
	UserID        string `json:"userId"`
	Kind          string `json:"kind"`
	SchemaName    string `json:"schemaName"`
	SchemaVersion int    `json:"schemaVersion"`
	CreatedAt     Millis `json:"createdAt"`
}

// Oven is one machine that can run a thread.
type Oven struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Fingerprint     string `json:"fingerprint"`
	LastHeartbeatAt Millis `json:"lastHeartbeatAt"`
	Descriptor      JSON   `json:"descriptor"`
}

// JSON is raw JSON captured from a jsonb column.
type JSON []byte

// MarshalJSON emits the captured bytes verbatim.
func (j JSON) MarshalJSON() ([]byte, error) {
	if len(j) == 0 {
		return []byte("{}"), nil
	}
	return j, nil
}

// StatusCounts bucket the nine thread statuses for a project.
//
// attention: created, planning, awaiting_approval, interrupted
// spec: spec
// working: executing, working-paused
// done: completed
// failed: failed
type StatusCounts struct {
	Attention int `json:"attention"`
	Spec      int `json:"spec"`
	Working   int `json:"working"`
	Done      int `json:"done"`
	Failed    int `json:"failed"`
}

// Project is one project with its thread rollup.
type Project struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Path         string       `json:"path"`
	Source       string       `json:"source"`
	Host         *string      `json:"host"`
	OvenID       *string      `json:"ovenId"`
	ProviderID   string       `json:"providerId"`
	WorkflowID   string       `json:"workflowId"`
	Icon         *string      `json:"icon"`
	Color        *string      `json:"color"`
	IconType     *string      `json:"iconType"`
	CustomSVG    *string      `json:"customSvg"`
	Pinned       bool         `json:"pinned"`
	Hidden       bool         `json:"hidden"`
	SortOrder    *int         `json:"sortOrder"`
	ThreadCount  int          `json:"threadCount"`
	UnreadCount  int          `json:"unreadCount"`
	StatusCounts StatusCounts `json:"statusCounts"`
	CreatedAt    Millis       `json:"createdAt"`
	UpdatedAt    Millis       `json:"updatedAt"`

	// ActivityMillis and CreatedMillis are the exact epoch-ms sort keys the
	// query ordered by, so a page cursor never drifts from a rounded timestamp.
	// They are not part of the payload.
	ActivityMillis int64 `json:"-"`
	CreatedMillis  int64 `json:"-"`
}

// Thread is one conversation. Model and Harness are the identity the thread
// runs on and are nullable: an unstarted thread has no run to name.
type Thread struct {
	ID                 string  `json:"id"`
	ProjectID          string  `json:"projectId"`
	Title              string  `json:"title"`
	Status             string  `json:"status"`
	Read               bool    `json:"read"`
	Pinned             bool    `json:"pinned"`
	Archived           bool    `json:"archived"`
	Drafting           bool    `json:"drafting"`
	Model              *string `json:"model"`
	Harness            *string `json:"harness"`
	LastError          *string `json:"lastError"`
	MessageCount       int     `json:"messageCount"`
	LastMessagePreview *string `json:"lastMessagePreview"`
	LastActivity       Millis  `json:"lastActivity"`
	CreatedAt          Millis  `json:"createdAt"`
	UpdatedAt          Millis  `json:"updatedAt"`

	// ActivityMillis is the exact epoch-ms value the list query ordered by.
	// Not part of the payload.
	ActivityMillis int64 `json:"-"`
}

// Message is one stored turn.
type Message struct {
	ID        string `json:"id"`
	ThreadID  string `json:"threadId"`
	Role      string `json:"role"`
	Body      string `json:"body"`
	Seq       int    `json:"seq"`
	CreatedAt Millis `json:"createdAt"`
}

// Prompt is one queued instruction for an Oven.
type Prompt struct {
	ID        string  `json:"id"`
	ThreadID  string  `json:"threadId"`
	Body      string  `json:"body"`
	State     string  `json:"state"`
	CreatedAt Millis  `json:"createdAt"`
	UpdatedAt Millis  `json:"updatedAt"`
	Error     *string `json:"error,omitempty"`
}

// Cursor identifies the last row of a page. Its meaning depends on Sort.
type Cursor struct {
	Sort   string
	Number int64  // activity/created milliseconds, or a message seq
	Name   string // lower(name) for the name sort
	Flag   bool   // thread pinned flag
	ID     string
}

// String is a debug helper so a cursor is legible in test failures.
func (c Cursor) String() string {
	return c.Sort + "/" + c.ID + "/" + c.Name + "/" + strconv.FormatInt(c.Number, 10)
}
