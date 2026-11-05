package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The two enums the composer's chips cycle through.
var (
	// ThinkingLevels are the reasoning levels a thread may state, in the order the
	// picker offers them.
	ThinkingLevels = []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	// PermissionLevels are how tool calls are approved for a message.
	PermissionLevels = []string{"auto_review", "full_access"}
)

// Field is one column a PATCH may write.
//
// It exists because Go's decoder cannot tell an absent JSON key from an explicit
// null, and the contract gives them different meanings: an absent field leaves
// the column alone, and null clears it. Set is whether the key was present, Value
// is what it held (nil for an explicit null).
type Field[T any] struct {
	Set   bool
	Value *T
}

// value is the column value for this field: nil means NULL.
func (f Field[T]) value() any {
	if !f.Set || f.Value == nil {
		return nil
	}
	return *f.Value
}

// flag reads a boolean field. An explicit null reads as false because the columns
// behind the switches are NOT NULL, so "cleared" and "off" are the same thing.
func flag(f Field[bool]) bool {
	return f.Value != nil && *f.Value
}

// ThreadPatch is a partial update of the composer's choices on one thread.
//
// Every field is optional: a client sends only what changed, and the columns it
// does not name keep their value.
type ThreadPatch struct {
	Model      Field[string]
	Thinking   Field[string]
	Permission Field[string]
	Account    Field[string]
	OvenID     Field[string]
	FileSystem Field[bool]
}

// assignments builds the SET clause for one patch. The column names are constants
// of this file, so no user input reaches the SQL text.
func (patch ThreadPatch) assignments() (string, []any) {
	sets := make([]string, 0, 6)
	args := make([]any, 0, 6)
	add := func(column string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
	}

	if patch.Model.Set {
		add("model", patch.Model.value())
	}
	if patch.Thinking.Set {
		add("thinking", patch.Thinking.value())
	}
	if patch.Permission.Set {
		add("permission", patch.Permission.value())
	}
	if patch.Account.Set {
		add("account", patch.Account.value())
	}
	if patch.OvenID.Set {
		add("oven_id", patch.OvenID.value())
	}
	if patch.FileSystem.Set {
		add("file_system", flag(patch.FileSystem))
	}
	return strings.Join(sets, ", "), args
}

// inherit fills every choice the caller left out from the thread row.
//
// A prompt has to state the full choice, because the desktop that picks it up may
// read the thread long after it was changed for the next message. Inheriting here,
// inside the same transaction that queues the prompt, keeps the two consistent.
func (patch ThreadPatch) inherit(thread Thread) ThreadPatch {
	if !patch.Model.Set {
		patch.Model = Field[string]{Set: true, Value: thread.Model}
	}
	if !patch.Thinking.Set {
		patch.Thinking = Field[string]{Set: true, Value: thread.Thinking}
	}
	if !patch.Permission.Set {
		patch.Permission = Field[string]{Set: true, Value: thread.Permission}
	}
	if !patch.Account.Set {
		patch.Account = Field[string]{Set: true, Value: thread.Account}
	}
	if !patch.OvenID.Set {
		patch.OvenID = Field[string]{Set: true, Value: thread.OvenID}
	}
	if !patch.FileSystem.Set {
		enabled := thread.FileSystem
		patch.FileSystem = Field[bool]{Set: true, Value: &enabled}
	}
	return patch
}

// UpdateThreadComposer writes the composer's choices on one thread and returns
// the thread as the list would read it. A missing thread is ErrNotFound, which the
// HTTP layer turns into 404 rather than a silent no-op.
func (s *Store) UpdateThreadComposer(
	ctx context.Context, schemaName, threadID string, patch ThreadPatch,
) (Thread, error) {
	var thread Thread
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		setClause, args := patch.assignments()
		// updated_at always moves: the patch is a change to the row even when it
		// only restates a value, and a client sorts by it.
		statement := "UPDATE threads SET updated_at = now()"
		if setClause != "" {
			statement = "UPDATE threads SET " + setClause + ", updated_at = now()"
		}
		args = append(args, threadID)
		statement += fmt.Sprintf(" WHERE id = $%d", len(args))

		tag, err := tx.Exec(ctx, statement, args...)
		if err != nil {
			return fmt.Errorf("store: update thread composer: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}

		thread, err = threadByID(ctx, tx, threadID)
		return err
	})
	if err != nil {
		return Thread{}, err
	}
	return thread, nil
}

// recentModelsLimit bounds the rows read for the picker's recent list. The catalog
// filter happens in Go, so a few unknown ids in front must not starve the list.
const recentModelsLimit = 50

// RecentModels returns the model ids this user's threads used in the last thirty
// days, most recently active first. Threads without a model state nothing and are
// skipped.
func (s *Store) RecentModels(ctx context.Context, schemaName string) ([]string, error) {
	out := make([]string, 0, recentModelsLimit)
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT model
			FROM threads
			WHERE model IS NOT NULL
			  AND last_activity >= now() - interval '30 days'
			GROUP BY model
			ORDER BY MAX(last_activity) DESC
			LIMIT $1`, recentModelsLimit)
		if err != nil {
			return fmt.Errorf("store: list recent models: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return fmt.Errorf("store: scan recent model: %w", err)
			}
			out = append(out, id)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("store: list recent models: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ThreadUsage derives the context meter's numbers for one thread.
//
// Everything is read from stored token columns: a turn that reported nothing
// counts as 0, and nothing is estimated from a body's length.
func (s *Store) ThreadUsage(ctx context.Context, schemaName, threadID string) (Usage, error) {
	var usage Usage
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		usage, err = threadUsage(ctx, tx, threadID)
		return err
	})
	if err != nil {
		return Usage{}, err
	}
	return usage, nil
}

// threadUsage reads the usage of one thread inside an already open transaction, so
// a reset and the payload it answers with see the same state.
func threadUsage(ctx context.Context, tx pgx.Tx, threadID string) (Usage, error) {
	var (
		usage  Usage
		used   int64
		window *int
		since  *time.Time
	)

	// The FILTER is where a reset bites: a reset only counts messages stored after
	// it, so the meter starts from zero without deleting anything.
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0))
		                FILTER (WHERE t.usage_reset_at IS NULL OR m.created_at > t.usage_reset_at), 0),
		       t.context_window,
		       t.usage_reset_at
		FROM threads t
		LEFT JOIN messages m ON m.thread_id = t.id
		WHERE t.id = $1
		GROUP BY t.id, t.context_window, t.usage_reset_at`, threadID).
		Scan(&used, &window, &since)
	if err != nil {
		return Usage{}, mapNoRows(err)
	}

	usage.Used = int(used)
	if window != nil {
		usage.Window = *window
	}
	usage.LeftBeforeCompact = usage.Window - usage.Used
	if usage.LeftBeforeCompact < 0 {
		usage.LeftBeforeCompact = 0
	}
	usage.Since = asMillis(since)

	var (
		input    *int
		output   *int
		duration *int
		cost     *int
	)
	err = tx.QueryRow(ctx, `
		SELECT m.input_tokens, m.output_tokens, m.duration_ms, m.cost_micros
		FROM messages m
		WHERE m.thread_id = $1 AND m.role = 'assistant'
		ORDER BY m.created_at DESC, m.seq DESC
		LIMIT 1`, threadID).Scan(&input, &output, &duration, &cost)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Usage{}, fmt.Errorf("store: read latest assistant turn: %w", err)
	}

	usage.ThisTurn = UsageTurn{Input: intOr0(input), Output: intOr0(output)}
	if output != nil && duration != nil && *duration > 0 {
		usage.Rate = float64(*output) / (float64(*duration) / 1000)
	}
	usage.CostMicros = intOr0(cost)
	return usage, nil
}

// intOr0 reads a nullable column as 0, for the places where the contract says an
// absent count is zero rather than unknown.
func intOr0(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// ResetThreadUsage moves the meter's start to now and returns the meter as it now
// reads. Messages are untouched: a reset changes what is counted, not what was
// said.
func (s *Store) ResetThreadUsage(
	ctx context.Context, schemaName, threadID string,
) (Usage, error) {
	var usage Usage
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE threads SET usage_reset_at = now(), updated_at = now()
			WHERE id = $1`, threadID)
		if err != nil {
			return fmt.Errorf("store: reset thread usage: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}

		usage, err = threadUsage(ctx, tx, threadID)
		return err
	})
	if err != nil {
		return Usage{}, err
	}
	return usage, nil
}

// OvenOwnedBy reports whether ovenID is one of this user's Ovens. Ovens live in
// the control plane, so the user id is what scopes the lookup, not a schema.
func (s *Store) OvenOwnedBy(ctx context.Context, userID, ovenID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM ovens WHERE id = $1 AND user_id = $2)`,
		ovenID, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("store: check oven ownership: %w", err)
	}
	return exists, nil
}

// AttachmentInput is one upload to store.
type AttachmentInput struct {
	ID       string
	ThreadID string
	Name     string
	Mime     string
	Bytes    []byte
}

// attachmentColumns is the scan order for Attachment, without the bytes: a list of
// attachments never carries them.
const attachmentColumns = `id, thread_id, prompt_id, name, mime, size, created_at`

// scanAttachment reads one attachment row.
func scanAttachment(row pgx.Row) (Attachment, error) {
	var (
		attachment Attachment
		promptID   *string
		created    time.Time
	)
	if err := row.Scan(&attachment.ID, &attachment.ThreadID, &promptID, &attachment.Name,
		&attachment.Mime, &attachment.Size, &created); err != nil {
		return Attachment{}, mapNoRows(err)
	}
	attachment.PromptID = promptID
	attachment.CreatedAt = FromTime(created)
	return attachment, nil
}

// CreateAttachment stores one uploaded file against a thread. The thread must
// exist, because a foreign-key failure would surface as a 500 instead of the 404 a
// stale thread id deserves.
func (s *Store) CreateAttachment(
	ctx context.Context, schemaName string, input AttachmentInput,
) (Attachment, error) {
	var attachment Attachment
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM threads WHERE id = $1)`,
			input.ThreadID).Scan(&exists); err != nil {
			return fmt.Errorf("store: check thread: %w", err)
		}
		if !exists {
			return ErrNotFound
		}

		var err error
		attachment, err = scanAttachment(tx.QueryRow(ctx, `
			INSERT INTO attachments (id, thread_id, name, mime, size, bytes)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING `+attachmentColumns,
			input.ID, input.ThreadID, input.Name, input.Mime, len(input.Bytes), input.Bytes))
		if err != nil {
			return fmt.Errorf("store: insert attachment: %w", err)
		}
		return nil
	})
	if err != nil {
		return Attachment{}, err
	}
	return attachment, nil
}

// AttachmentContent returns one attachment with its bytes, for the download route.
func (s *Store) AttachmentContent(
	ctx context.Context, schemaName, attachmentID string,
) (Attachment, []byte, error) {
	var (
		attachment Attachment
		bytes      []byte
	)
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var (
			promptID *string
			created  time.Time
		)
		err := tx.QueryRow(ctx,
			`SELECT `+attachmentColumns+`, bytes FROM attachments WHERE id = $1`,
			attachmentID,
		).Scan(&attachment.ID, &attachment.ThreadID, &promptID, &attachment.Name,
			&attachment.Mime, &attachment.Size, &created, &bytes)
		if err != nil {
			return mapNoRows(err)
		}
		attachment.PromptID = promptID
		attachment.CreatedAt = FromTime(created)
		return nil
	})
	if err != nil {
		return Attachment{}, nil, err
	}
	return attachment, bytes, nil
}

// DeleteAttachment removes an upload no prompt carries yet.
//
// Once a prompt carries it the file belongs to a message that may already be on
// its way to an Oven, so it is a conflict (409), not a silent delete.
func (s *Store) DeleteAttachment(ctx context.Context, schemaName, attachmentID string) error {
	return s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`DELETE FROM attachments WHERE id = $1 AND prompt_id IS NULL`, attachmentID)
		if err != nil {
			return fmt.Errorf("store: delete attachment: %w", err)
		}
		if tag.RowsAffected() > 0 {
			return nil
		}

		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments WHERE id = $1)`,
			attachmentID).Scan(&exists); err != nil {
			return fmt.Errorf("store: check attachment: %w", err)
		}
		if !exists {
			return ErrNotFound
		}
		return ErrConflict
	})
}

// bindAttachments hands uploaded files to the prompt that carries them.
//
// Every id must be one of this thread's still-unattached attachments: a stale id,
// another thread's file, or one already bound fails the whole enqueue with
// ErrAttachmentInvalid, so a queued prompt never silently loses a file the person
// attached.
func bindAttachments(
	ctx context.Context, tx pgx.Tx, threadID, promptID string, ids []string,
) error {
	if len(ids) == 0 {
		return nil
	}

	unique := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE attachments SET prompt_id = $1
		WHERE id = ANY ($2::text[]) AND thread_id = $3 AND prompt_id IS NULL`,
		promptID, unique, threadID)
	if err != nil {
		return fmt.Errorf("store: bind attachments: %w", err)
	}
	if int(tag.RowsAffected()) != len(unique) {
		return ErrAttachmentInvalid
	}
	return nil
}

// loadPromptAttachments fills the attachments of one already-scanned prompt. The
// slice is always allocated, so the JSON carries [] rather than null for a prompt
// sent without files.
func loadPromptAttachments(ctx context.Context, tx pgx.Tx, prompt *Prompt) error {
	rows, err := tx.Query(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE prompt_id = $1
		 ORDER BY created_at, id`, prompt.ID)
	if err != nil {
		return fmt.Errorf("store: list prompt attachments: %w", err)
	}
	defer rows.Close()

	attachments := make([]Attachment, 0, 2)
	for rows.Next() {
		attachment, err := scanAttachment(rows)
		if err != nil {
			return fmt.Errorf("store: scan prompt attachment: %w", err)
		}
		attachments = append(attachments, attachment)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("store: list prompt attachments: %w", err)
	}
	prompt.Attachments = attachments
	return nil
}

// PromptInput is one prompt to queue: the body, the idempotency key, the files it
// carries and the composer choices it inherits where the caller stated none.
type PromptInput struct {
	ID            string
	ThreadID      string
	Body          string
	ClientID      string
	AttachmentIDs []string
	Choices       ThreadPatch
}

// EnqueuePrompt stores a prompt for an Oven to pick up. A non-empty clientID makes
// the call idempotent: the existing prompt is returned with created false.
//
// The choices the caller left out are read from the thread row in this same
// transaction, and the attachments are bound to the new prompt here too, so a
// prompt either carries everything the person sent or is not queued at all.
func (s *Store) EnqueuePrompt(
	ctx context.Context, schemaName string, input PromptInput,
) (Prompt, bool, error) {
	var (
		prompt  Prompt
		created bool
	)

	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		thread, err := threadByID(ctx, tx, input.ThreadID)
		if err != nil {
			return err
		}
		choices := input.Choices.inherit(thread)

		if input.ClientID != "" {
			existing, err := scanPrompt(tx.QueryRow(ctx,
				`SELECT `+promptColumns+` FROM prompts WHERE thread_id = $1 AND client_id = $2`,
				input.ThreadID, input.ClientID))
			if err == nil {
				prompt = existing
				created = false
				return loadPromptAttachments(ctx, tx, &prompt)
			}
			if !errors.Is(err, ErrNotFound) {
				return err
			}
		}

		var client any
		if input.ClientID != "" {
			client = input.ClientID
		}
		prompt, err = scanPrompt(tx.QueryRow(ctx, `
			INSERT INTO prompts (id, thread_id, body, state, client_id,
			                     model, thinking, permission, account, oven_id, file_system)
			VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10)
			RETURNING `+promptColumns,
			input.ID, input.ThreadID, input.Body, client,
			choices.Model.value(), choices.Thinking.value(), choices.Permission.value(),
			choices.Account.value(), choices.OvenID.value(), flag(choices.FileSystem)))
		if err != nil {
			// A concurrent insert with the same client id wins the race; return it
			// instead of queueing the message twice.
			if isUniqueViolation(err) && input.ClientID != "" {
				prompt, err = scanPrompt(tx.QueryRow(ctx,
					`SELECT `+promptColumns+` FROM prompts WHERE thread_id = $1 AND client_id = $2`,
					input.ThreadID, input.ClientID))
				if err != nil {
					return err
				}
				created = false
				return loadPromptAttachments(ctx, tx, &prompt)
			}
			return fmt.Errorf("store: enqueue prompt: %w", err)
		}

		if err := bindAttachments(ctx, tx, input.ThreadID, prompt.ID, input.AttachmentIDs); err != nil {
			return err
		}
		created = true
		return loadPromptAttachments(ctx, tx, &prompt)
	})
	if err != nil {
		return Prompt{}, false, err
	}
	return prompt, created, nil
}
