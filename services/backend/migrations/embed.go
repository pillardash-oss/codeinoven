// Package migrations embeds the SQL this service applies to Postgres.
//
// There are two sets: `control`, the single public schema holding identity,
// devices, sessions and the registry of per-user stores; and `store`, the
// template that is applied to every user's own schema when it is provisioned.
// One runner in internal/store applies both, forward only, and refuses to start
// when a recorded checksum no longer matches the file on disk.
package migrations

import "embed"

// FS holds control/*.sql and store/*.sql.
//
//go:embed control/*.sql store/*.sql
var FS embed.FS
