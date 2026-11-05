package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Project sort keys accepted by GET /v1/projects.
const (
	ProjectSortActivity = "activity"
	ProjectSortName     = "name"
	ProjectSortCreated  = "created"
)

// ProjectFilter is the query for GET /v1/projects.
type ProjectFilter struct {
	Sort   string
	Query  string
	Limit  int
	Cursor *Cursor
}

// ThreadFilter is the query for GET /v1/threads.
type ThreadFilter struct {
	ProjectID string
	Statuses  []string
	Query     string
	Unread    bool
	Limit     int
	Cursor    *Cursor
}

// MessageFilter is the query for GET /v1/threads/{id}/messages.
type MessageFilter struct {
	Limit  int
	Cursor *Cursor
}

// StatusGroups maps the `state` query value to the statuses it selects.
//
// A caller may pass a group name (attention, spec, working, done, failed) or one
// exact status from the contract.
var StatusGroups = map[string][]string{
	"attention": {"created", "planning", "awaiting_approval", "interrupted"},
	"spec":      {"spec"},
	"working":   {"executing", "working-paused"},
	"done":      {"completed"},
	"failed":    {"failed"},
}

// ThreadStatuses are the nine statuses a thread may hold.
var ThreadStatuses = []string{
	"created", "planning", "awaiting_approval", "spec", "executing",
	"working-paused", "interrupted", "completed", "failed",
}

// LikePattern turns user input into a case insensitive contains pattern. `!` is
// the escape character in the queries so no backslash escaping is involved.
func LikePattern(query string) string {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return "%"
	}
	replacer := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_")
	return "%" + replacer.Replace(trimmed) + "%"
}

func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return 50
	case limit > 200:
		return 200
	default:
		return limit
	}
}

// projectRollup is the thread aggregate joined onto every project row.
const projectRollup = `
	LEFT JOIN (
		SELECT t.project_id,
		       COUNT(*) AS thread_count,
		       COUNT(*) FILTER (WHERE NOT t.read AND NOT t.archived) AS unread_count,
		       COUNT(*) FILTER (WHERE NOT t.archived AND t.status IN
		           ('created', 'planning', 'awaiting_approval', 'interrupted')) AS attention,
		       COUNT(*) FILTER (WHERE NOT t.archived AND t.status = 'spec') AS spec_count,
		       COUNT(*) FILTER (WHERE NOT t.archived AND t.status IN
		           ('executing', 'working-paused')) AS working,
		       COUNT(*) FILTER (WHERE NOT t.archived AND t.status = 'completed') AS done,
		       COUNT(*) FILTER (WHERE NOT t.archived AND t.status = 'failed') AS failed,
		       MAX(t.last_activity) AS last_activity
		FROM threads t
		GROUP BY t.project_id
	) r ON r.project_id = p.id`

// projectColumns is the scan order for Project.
const projectColumns = `p.id, p.name, p.path, p.source, p.host, p.oven_id, p.provider_id,
	p.workflow_id, p.icon, p.color, p.icon_type, p.custom_svg, p.pinned, p.hidden, p.sort_order,
	p.created_at, p.updated_at,
	COALESCE(r.thread_count, 0) AS thread_count,
	COALESCE(r.unread_count, 0) AS unread_count,
	COALESCE(r.attention, 0) AS attention,
	COALESCE(r.spec_count, 0) AS spec_count,
	COALESCE(r.working, 0) AS working,
	COALESCE(r.done, 0) AS done,
	COALESCE(r.failed, 0) AS failed`

// projectOuterColumns drops the cursor helper column the inner query adds.
const projectOuterColumns = `id, name, path, source, host, oven_id, provider_id, workflow_id,
	icon, color, icon_type, custom_svg, pinned, hidden, sort_order, created_at, updated_at,
	thread_count, unread_count, attention, spec_count, working, done, failed`

func scanProject(row pgx.Row) (Project, error) {
	var (
		project   Project
		host      *string
		ovenID    *string
		icon      *string
		color     *string
		iconType  *string
		customSVG *string
		sortOrder *int
		created   time.Time
		updated   time.Time
	)
	err := row.Scan(
		&project.ID, &project.Name, &project.Path, &project.Source, &host, &ovenID,
		&project.ProviderID, &project.WorkflowID, &icon, &color, &iconType, &customSVG,
		&project.Pinned, &project.Hidden, &sortOrder, &created, &updated,
		&project.ThreadCount, &project.UnreadCount,
		&project.StatusCounts.Attention, &project.StatusCounts.Spec, &project.StatusCounts.Working,
		&project.StatusCounts.Done, &project.StatusCounts.Failed,
		&project.ActivityMillis, &project.CreatedMillis,
	)
	if err != nil {
		return Project{}, mapNoRows(err)
	}
	project.Host = host
	project.OvenID = ovenID
	project.Icon = icon
	project.Color = color
	project.IconType = iconType
	project.CustomSVG = customSVG
	project.SortOrder = sortOrder
	project.CreatedAt = FromTime(created)
	project.UpdatedAt = FromTime(updated)
	return project, nil
}

// ListProjects returns one page of projects plus whether another page exists.
func (s *Store) ListProjects(
	ctx context.Context, schemaName string, filter ProjectFilter,
) ([]Project, bool, error) {
	sort := filter.Sort
	if sort == "" {
		sort = ProjectSortActivity
	}
	limit := clampLimit(filter.Limit)

	var (
		sortExpression string
		cursorClause   string
		orderClause    string
	)
	switch sort {
	case ProjectSortActivity:
		sortExpression = `(EXTRACT(EPOCH FROM COALESCE(r.last_activity, p.updated_at)) * 1000)::bigint`
		cursorClause = `($2::boolean IS NOT TRUE OR (s.sort_number, s.id) < ($3::bigint, $4::text))`
		orderClause = `s.sort_number DESC, s.id DESC`
	case ProjectSortCreated:
		sortExpression = `(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint`
		cursorClause = `($2::boolean IS NOT TRUE OR (s.sort_number, s.id) < ($3::bigint, $4::text))`
		orderClause = `s.sort_number DESC, s.id DESC`
	case ProjectSortName:
		sortExpression = `lower(p.name)`
		cursorClause = `($2::boolean IS NOT TRUE OR (s.sort_name, s.id) > ($3::text, $4::text))`
		orderClause = `s.sort_name ASC, s.id ASC`
	default:
		return nil, false, fmt.Errorf("store: unknown project sort %q", sort)
	}

	inner := `SELECT ` + projectColumns + `, ` + sortExpression + ` AS sort_number,
			lower(p.name) AS sort_name,
			(EXTRACT(EPOCH FROM COALESCE(r.last_activity, p.updated_at)) * 1000)::bigint AS activity_ms,
			(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS created_ms
			FROM projects p` + projectRollup + `
			WHERE p.name ILIKE $1 ESCAPE '!' OR p.path ILIKE $1 ESCAPE '!'`

	query := `SELECT ` + projectOuterColumns + `, s.activity_ms, s.created_ms FROM (` + inner + `) s
		WHERE ` + cursorClause + `
		ORDER BY ` + orderClause + `
		LIMIT $5`

	pattern := LikePattern(filter.Query)
	hasCursor := filter.Cursor != nil

	// The cursor key is numeric for activity/created and textual for name, so it
	// is passed as the argument type that matches the placeholder's cast.
	var (
		numberKey *int64
		nameKey   *string
		cursorID  *string
	)
	if filter.Cursor != nil {
		id := filter.Cursor.ID
		cursorID = &id
		if sort == ProjectSortName {
			name := filter.Cursor.Name
			nameKey = &name
		} else {
			number := filter.Cursor.Number
			numberKey = &number
		}
	}

	key := any(numberKey)
	if sort == ProjectSortName {
		key = nameKey
	}

	out := make([]Project, 0, limit+1)
	var more bool
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, query, pattern, hasCursor, key, cursorID, limit+1)
		if err != nil {
			return fmt.Errorf("store: list projects: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			project, err := scanProject(rows)
			if err != nil {
				return fmt.Errorf("store: scan project: %w", err)
			}
			out = append(out, project)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("store: list projects: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}

	if len(out) > limit {
		out = out[:limit]
		more = true
	}
	return out, more, nil
}

// ProjectByID returns one project with its rollup.
func (s *Store) ProjectByID(ctx context.Context, schemaName, projectID string) (Project, error) {
	query := `SELECT ` + projectColumns + `,
		(EXTRACT(EPOCH FROM COALESCE(r.last_activity, p.updated_at)) * 1000)::bigint AS activity_ms,
		(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS created_ms
		FROM projects p` + projectRollup + ` WHERE p.id = $1`

	var project Project
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		project, err = scanProject(tx.QueryRow(ctx, query, projectID))
		return err
	})
	if err != nil {
		return Project{}, err
	}
	return project, nil
}

// threadColumns is the scan order for Thread.
const threadColumns = `t.id, t.project_id, t.title, t.status, t.read, t.pinned, t.archived,
	t.drafting, t.model, t.harness, t.thinking, t.permission, t.account, t.oven_id,
	t.file_system, t.context_window, t.usage_reset_at,
	t.last_error, t.message_count, t.last_message_preview,
	t.last_activity, t.created_at, t.updated_at,
	(EXTRACT(EPOCH FROM t.last_activity) * 1000)::bigint AS activity_ms`

func scanThread(row pgx.Row) (Thread, error) {
	var (
		thread        Thread
		model         *string
		harness       *string
		thinking      *string
		permission    *string
		account       *string
		ovenID        *string
		contextWindow *int
		usageResetAt  *time.Time
		lastError     *string
		preview       *string
		activity      time.Time
		created       time.Time
		updated       time.Time
	)
	err := row.Scan(
		&thread.ID, &thread.ProjectID, &thread.Title, &thread.Status, &thread.Read,
		&thread.Pinned, &thread.Archived, &thread.Drafting, &model, &harness, &thinking,
		&permission, &account, &ovenID, &thread.FileSystem, &contextWindow, &usageResetAt,
		&lastError, &thread.MessageCount, &preview, &activity, &created, &updated,
		&thread.ActivityMillis,
	)
	if err != nil {
		return Thread{}, mapNoRows(err)
	}
	thread.Model = model
	thread.Harness = harness
	thread.Thinking = thinking
	thread.Permission = permission
	thread.Account = account
	thread.OvenID = ovenID
	thread.ContextWindow = contextWindow
	thread.UsageResetAt = asMillis(usageResetAt)
	thread.LastError = lastError
	thread.LastMessagePreview = preview
	thread.LastActivity = FromTime(activity)
	thread.CreatedAt = FromTime(created)
	thread.UpdatedAt = FromTime(updated)
	return thread, nil
}

// threadByID reads one thread inside an already open transaction, so a write and
// the row it answers with see the same state.
func threadByID(ctx context.Context, tx pgx.Tx, threadID string) (Thread, error) {
	return scanThread(tx.QueryRow(ctx,
		`SELECT `+threadColumns+` FROM threads t WHERE t.id = $1`, threadID))
}

// ListThreads returns one page of threads plus whether another page exists.
// Order is pinned first, then most recent activity, then id, all descending.
func (s *Store) ListThreads(
	ctx context.Context, schemaName string, filter ThreadFilter,
) ([]Thread, bool, error) {
	limit := clampLimit(filter.Limit)
	pattern := LikePattern(filter.Query)

	var projectID *string
	if filter.ProjectID != "" {
		p := filter.ProjectID
		projectID = &p
	}

	query := `SELECT ` + threadColumns + `
		FROM threads t
		WHERE ($1::text IS NULL OR t.project_id = $1)
		  AND ($2::text[] IS NULL OR t.status = ANY ($2::text[]))
		  AND ($3::boolean IS NOT TRUE OR (NOT t.read AND NOT t.archived))
		  AND t.title ILIKE $4 ESCAPE '!'
		  AND ($5::boolean IS NOT TRUE OR
		       (t.pinned, (EXTRACT(EPOCH FROM t.last_activity) * 1000)::bigint, t.id)
		       < ($6::boolean, $7::bigint, $8::text))
		ORDER BY t.pinned DESC, (EXTRACT(EPOCH FROM t.last_activity) * 1000)::bigint DESC, t.id DESC
		LIMIT $9`

	hasCursor := filter.Cursor != nil
	var (
		cursorFlag   *bool
		cursorNumber *int64
		cursorID     *string
	)
	if hasCursor {
		flag := filter.Cursor.Flag
		number := filter.Cursor.Number
		id := filter.Cursor.ID
		cursorFlag = &flag
		cursorNumber = &number
		cursorID = &id
	}

	out := make([]Thread, 0, limit+1)
	var more bool
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, query, projectID, filter.Statuses, filter.Unread, pattern,
			hasCursor, cursorFlag, cursorNumber, cursorID, limit+1)
		if err != nil {
			return fmt.Errorf("store: list threads: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			thread, err := scanThread(rows)
			if err != nil {
				return fmt.Errorf("store: scan thread: %w", err)
			}
			out = append(out, thread)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("store: list threads: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}

	if len(out) > limit {
		out = out[:limit]
		more = true
	}
	return out, more, nil
}

// CreateThread inserts one thread that nobody has worked on yet and returns it
// as the list would read it. The project must exist: a thread without one has no
// sidebar to sit under, so a foreign-key failure is the caller's error to report.
func (s *Store) CreateThread(
	ctx context.Context, schemaName, threadID, projectID, title string,
) (Thread, error) {
	var thread Thread
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO threads (id, project_id, title) VALUES ($1, $2, $3)`,
			threadID, projectID, title,
		); err != nil {
			return err
		}
		var err error
		thread, err = threadByID(ctx, tx, threadID)
		return err
	})
	if err != nil {
		return Thread{}, err
	}
	return thread, nil
}

// ThreadByID returns one thread.
func (s *Store) ThreadByID(ctx context.Context, schemaName, threadID string) (Thread, error) {
	var thread Thread
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		thread, err = threadByID(ctx, tx, threadID)
		return err
	})
	if err != nil {
		return Thread{}, err
	}
	return thread, nil
}

// ListMessages returns one page of messages, oldest first.
func (s *Store) ListMessages(
	ctx context.Context, schemaName, threadID string, filter MessageFilter,
) ([]Message, bool, error) {
	limit := clampLimit(filter.Limit)

	hasCursor := filter.Cursor != nil
	var (
		cursorSeq *int64
		cursorID  *string
	)
	if hasCursor {
		seq := filter.Cursor.Number
		id := filter.Cursor.ID
		cursorSeq = &seq
		cursorID = &id
	}

	query := `SELECT m.id, m.thread_id, m.role, m.body, m.seq, m.created_at,
		m.input_tokens, m.output_tokens, m.duration_ms, m.cost_micros
		FROM messages m
		WHERE m.thread_id = $1
		  AND ($2::boolean IS NOT TRUE OR (m.seq, m.id) > ($3::bigint, $4::text))
		ORDER BY m.seq ASC, m.id ASC
		LIMIT $5`

	out := make([]Message, 0, limit+1)
	var more bool
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, query, threadID, hasCursor, cursorSeq, cursorID, limit+1)
		if err != nil {
			return fmt.Errorf("store: list messages: %w", err)
		}
		defer rows.Close()

		for rows.Next() {
			var (
				message  Message
				created  time.Time
				input    *int
				output   *int
				duration *int
				cost     *int
			)
			if err := rows.Scan(&message.ID, &message.ThreadID, &message.Role, &message.Body,
				&message.Seq, &created, &input, &output, &duration, &cost); err != nil {
				return fmt.Errorf("store: scan message: %w", err)
			}
			message.CreatedAt = FromTime(created)
			message.InputTokens = input
			message.OutputTokens = output
			message.DurationMs = duration
			message.CostMicros = cost
			out = append(out, message)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("store: list messages: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}

	if len(out) > limit {
		out = out[:limit]
		more = true
	}
	return out, more, nil
}

// promptColumns is the scan order for Prompt.
const promptColumns = `id, thread_id, body, state, error, created_at, updated_at,
	model, thinking, permission, account, oven_id, file_system`

func scanPrompt(row pgx.Row) (Prompt, error) {
	var (
		prompt     Prompt
		lastError  *string
		created    time.Time
		updated    time.Time
		model      *string
		thinking   *string
		permission *string
		account    *string
		ovenID     *string
	)
	prompt.Attachments = make([]Attachment, 0, 2)
	if err := row.Scan(&prompt.ID, &prompt.ThreadID, &prompt.Body, &prompt.State,
		&lastError, &created, &updated, &model, &thinking, &permission, &account, &ovenID,
		&prompt.FileSystem); err != nil {
		return Prompt{}, mapNoRows(err)
	}
	prompt.Error = lastError
	prompt.CreatedAt = FromTime(created)
	prompt.UpdatedAt = FromTime(updated)
	prompt.Model = model
	prompt.Thinking = thinking
	prompt.Permission = permission
	prompt.Account = account
	prompt.OvenID = ovenID
	return prompt, nil
}

// PromptByID returns one prompt with its attachments.
//
// EnqueuePrompt, which shares the composer columns, lives in content-composer.go.
func (s *Store) PromptByID(ctx context.Context, schemaName, promptID string) (Prompt, error) {
	var prompt Prompt
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		prompt, err = scanPrompt(tx.QueryRow(ctx,
			`SELECT `+promptColumns+` FROM prompts WHERE id = $1`, promptID))
		if err != nil {
			return err
		}
		return loadPromptAttachments(ctx, tx, &prompt)
	})
	if err != nil {
		return Prompt{}, err
	}
	return prompt, nil
}

// The one state a person may still change. Once an Oven has claimed a prompt it
// belongs to the run, and the service refuses to rewrite or remove it.
const promptQueuedState = "queued"

// promptNotQueued turns a failed guarded write into the reason it failed: a
// prompt that does not exist, or one that is already on its way.
func promptNotQueued(tx pgx.Tx, ctx context.Context, promptID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM prompts WHERE id = $1)`, promptID).
		Scan(&exists); err != nil {
		return fmt.Errorf("store: check prompt: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return ErrConflict
}

// DeletePrompt removes a prompt the Oven has not claimed yet. A prompt that is
// already being answered is a conflict rather than a silent no-op, so the phone
// can say why the held message is not its to remove anymore.
func (s *Store) DeletePrompt(ctx context.Context, schemaName, promptID string) error {
	return s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`DELETE FROM prompts WHERE id = $1 AND state = $2`, promptID, promptQueuedState)
		if err != nil {
			return fmt.Errorf("store: delete prompt: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return promptNotQueued(tx, ctx, promptID)
		}
		return nil
	})
}

// SteerPrompt moves a queued prompt ahead of the rest of its thread's queue, so
// the Oven takes it next instead of finishing the queue in order. The state is
// the record of that: `steering` means the prompt is no longer waiting its turn.
func (s *Store) SteerPrompt(
	ctx context.Context, schemaName, promptID string,
) (Prompt, error) {
	var prompt Prompt
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		var err error
		prompt, err = scanPrompt(tx.QueryRow(ctx, `
			UPDATE prompts SET state = 'steering', updated_at = now()
			WHERE id = $1 AND state = $2
			RETURNING `+promptColumns, promptID, promptQueuedState))
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return promptNotQueued(tx, ctx, promptID)
			}
			return fmt.Errorf("store: steer prompt: %w", err)
		}
		return loadPromptAttachments(ctx, tx, &prompt)
	})
	if err != nil {
		return Prompt{}, err
	}
	return prompt, nil
}
