package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Assistant is one helper the account owns, as GET /v1/assistants returns it.
//
// The desktop's own assistants table is the source of these rows, and the stored
// custom SVG travels with the row so the phone draws the same mark rather than a
// placeholder glyph.
type Assistant struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Description  string  `json:"description"`
	ScheduleName *string `json:"scheduleName"`
	Color        *string `json:"color"`
	CustomSVG    *string `json:"customSvg"`
	Scheduled    bool    `json:"scheduled"`
	Paused       bool    `json:"paused"`
	ThreadCount  int     `json:"threadCount"`
	LastRunAt    *Millis `json:"lastRunAt"`
	UpdatedAt    Millis  `json:"updatedAt"`
}

// ListAssistants returns every assistant in the user's store, in the order the
// desktop keeps them.
func (s *Store) ListAssistants(ctx context.Context, schemaName string) ([]Assistant, error) {
	var assistants []Assistant
	err := s.withSchema(ctx, schemaName, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, description, schedule_name, color, custom_svg,
				scheduled, paused, thread_count,
				(EXTRACT(EPOCH FROM last_run_at) * 1000)::bigint,
				(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint
			FROM assistants
			ORDER BY sort_order NULLS LAST, name ASC`)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var (
				assistant Assistant
				lastRun   *int64
				updated   int64
			)
			if err := rows.Scan(
				&assistant.ID, &assistant.Name, &assistant.Description,
				&assistant.ScheduleName, &assistant.Color, &assistant.CustomSVG,
				&assistant.Scheduled, &assistant.Paused, &assistant.ThreadCount,
				&lastRun, &updated,
			); err != nil {
				return err
			}
			if lastRun != nil {
				value := Millis(*lastRun)
				assistant.LastRunAt = &value
			}
			assistant.UpdatedAt = Millis(updated)
			assistants = append(assistants, assistant)
		}
		return rows.Err()
	})
	return assistants, err
}
