/** Stable names for the app-owned core tools the Pi core-tools extension registers. */

/** Structured multi-question ask rendered by the app's question cards. */
export const CIO_ASK_USER_TOOL_NAME = 'cio_ask_user'
/** Todo tracking; the `{ todos: [...] }` input shape matches the renderer's todo-tool detection. */
export const CIO_TODO_WRITE_TOOL_NAME = 'cio_todo_write'
/** Asks the user for file paths, validates them, and returns a structured file list. */
export const CIO_REQUEST_FILES_TOOL_NAME = 'cio_request_files'
/**
 * Collects one or more secret values from the user without the value ever
 * reaching the model. The value is stored in the encrypted vault (and bound to a
 * utility when the agent names one) and exposed to the session as an OS
 * environment variable; the tool answers only with `Secret set, you may
 * proceed.` plus the environment variable names.
 */
export const CIO_ASK_SECRET_TOOL_NAME = 'cio_ask_secret'
/** Spawns nested sub-agent worker threads controlled by the primary agent. */
export const CIO_SPAWN_AGENT_TOOL_NAME = 'cio_spawn_agent'
/** Checks or waits for spawned sub-agent threads; returns metadata only. */
export const CIO_AGENT_STATUS_TOOL_NAME = 'cio_agent_status'
/** Reads the final output of finished sub-agent threads, keyed by agent id. */
export const CIO_AGENT_OUTPUT_TOOL_NAME = 'cio_agent_output'
/** Custom-message type that announces a finished background sub-agent to the driver. */
export const CIO_SUBAGENT_DONE_MESSAGE_TYPE = 'cio-subagent-done'
/**
 * `ctx.ui.setStatus` key the core-tools extension uses to stream a live sub-agent
 * (child pi session) event feed to the driver. The payload is a JSON envelope
 * `{ childSessionId, records: [...pi records] }`, and the driver maps each record
 * through the same `mapPiRecord` mapper a root thread uses, emitting child-scoped
 * `agent:event`s so the sub-agent transcript streams like a normal thread. The
 * channel is fire-and-forget, so it never blocks the child, and it never enters
 * the primary agent's model context.
 */
export const CIO_SUBAGENT_STREAM_STATUS_KEY = 'codeinoven-subagent-stream'

/** Tool names registered by the core-tools extension (exported for tests). */
export const PI_CORE_TOOLS_TOOL_NAMES = [
  CIO_ASK_USER_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME,
  CIO_REQUEST_FILES_TOOL_NAME,
  CIO_ASK_SECRET_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_AGENT_OUTPUT_TOOL_NAME
] as const
