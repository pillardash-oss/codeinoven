import { Logger } from '../../system/logger'

/**
 * Main-thread SQLite work above one 60 Hz frame is diagnostic-worthy.
 *
 * The synchronous API is reserved for startup, migrations, writes and the
 * primary-connection fallback a worker-backed read takes when no worker exists
 * (see the main-thread SQLite rule in `docs/APP-BIBLE.md`). A statement that
 * does hold the frame reports itself with the call site that issued it.
 */
export const MAIN_THREAD_DATABASE_WARNING_MS = 16.7

/** Statement text attributed in slow-op logs; capped and normalized to a single line. */
const MAX_SLOW_OP_SQL_LENGTH = 240

/** Caller frames a slow-operation report names, innermost first. */
const SLOW_OP_FRAME_LIMIT = 3

/** Frames that name the database layer itself rather than the code to look at. */
const DATABASE_LAYER_FRAME =
  /node:internal|node_modules|mainThreadCallFrames|reportSlowMainThreadOperation|Database(?:Connection)?\.(?:get|all|run|transaction|prepare)\b/u

/**
 * Log only operation class, duration, the statement text, and the call site
 * (params and user data are never logged). The stack is walked only after the
 * statement has already held the main thread past a frame, so the report is
 * free on the normal path and names the feature that issued the statement:
 * the SQL alone says which query ran, not who ran it.
 */
export function reportSlowMainThreadOperation(
  operation: string,
  startedAt: number,
  sql?: string
): void {
  const durationMs = performance.now() - startedAt
  if (durationMs < MAIN_THREAD_DATABASE_WARNING_MS) return
  Logger.info('Slow synchronous SQLite operation on Electron main', {
    operation,
    durationMs: Math.round(durationMs * 10) / 10,
    sql: sql ? truncateSqlForLog(sql) : undefined,
    caller: mainThreadCallFrames()
  })
}

/**
 * The frames above the database layer in the current stack, innermost first.
 *
 * `new Error().stack` is read lazily, inside the slow path only, so a statement
 * that stays under the threshold pays nothing. The frames are what turn a
 * slow-operation report into a fix without an investigation: a packaged build
 * names the single bundle file and an offset, a dev build names the source file.
 */
function mainThreadCallFrames(limit = SLOW_OP_FRAME_LIMIT): string[] {
  const stack = new Error('slow-main-thread-sqlite').stack
  if (!stack) return []
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const frame = line.trim()
    if (!frame.startsWith('at ')) continue
    const text = frame.slice(3)
    if (DATABASE_LAYER_FRAME.test(text)) continue
    frames.push(text)
    if (frames.length >= limit) break
  }
  return frames
}

function truncateSqlForLog(sql: string): string {
  const singleLine = sql.replace(/\s+/gu, ' ').trim()
  return singleLine.length > MAX_SLOW_OP_SQL_LENGTH
    ? `${singleLine.slice(0, MAX_SLOW_OP_SQL_LENGTH)}…`
    : singleLine
}
