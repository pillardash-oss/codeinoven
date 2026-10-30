import type { Database as DatabaseType } from 'better-sqlite3'

/**
 * Column names declared on `table`, or an empty set when the table does not
 * exist at all.
 *
 * Migrations read this once and then guard every statement on it, so a step
 * stays a no-op on a database that already carries its change.
 */
export function tableColumns(connection: DatabaseType, table: string): Set<string> {
  const rows = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((column) => column.name))
}

/** Whether `table` exists in this database. */
export function tableExists(connection: DatabaseType, table: string): boolean {
  const row = connection
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: number } | undefined
  return row !== undefined
}

/** The SQL text of `table`, or undefined when it does not exist. */
export function tableSql(connection: DatabaseType, table: string): string | undefined {
  const row = connection
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined
  return row?.sql
}

/** Add `column` to `table` unless `columns` already lists it. */
export function addColumn(
  connection: DatabaseType,
  columns: Set<string>,
  table: string,
  column: string,
  definition: string
): void {
  if (columns.has(column)) return
  connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Column names declared in a CREATE TABLE column list.
 *
 * Reads only the top-level column declarations and stops at the first
 * table-level constraint, so a constraint line or its continuation is never
 * mistaken for a column.
 */
export function parseColumnNames(columnsSql: string): string[] {
  const names: string[] = []
  for (const rawLine of columnsSql.split('\n')) {
    const line = rawLine.trim().replace(/,$/u, '')
    if (!line || line.startsWith('--')) continue
    if (line.startsWith('CHECK') || line.startsWith('UNIQUE') || line.startsWith('PRIMARY KEY')) {
      break
    }
    const [name] = line.split(/\s+/u)
    if (name && /^[a-z_][a-z0-9_]*$/u.test(name)) names.push(name)
  }
  return names
}
