/** Stable names for the app-owned core tools the Pi core-tools extension registers. */

/** Structured multi-question ask rendered by the app's question cards. */
export const CIO_ASK_USER_TOOL_NAME = 'cio_ask_user'
/** Todo tracking; the `{ todos: [...] }` input shape matches the renderer's todo-tool detection. */
export const CIO_TODO_WRITE_TOOL_NAME = 'cio_todo_write'
/** Asks the user for file paths, validates them, and returns a structured file list. */
export const CIO_REQUEST_FILES_TOOL_NAME = 'cio_request_files'
/** Spawns nested sub-agent worker threads controlled by the primary agent. */
export const CIO_SPAWN_AGENT_TOOL_NAME = 'cio_spawn_agent'
/** Checks or waits for spawned sub-agent threads and collects their results. */
export const CIO_AGENT_STATUS_TOOL_NAME = 'cio_agent_status'
/** Custom-message type that announces a finished background sub-agent to the driver. */
export const CIO_SUBAGENT_DONE_MESSAGE_TYPE = 'cio-subagent-done'

/** Tool names registered by the core-tools extension (exported for tests). */
export const PI_CORE_TOOLS_TOOL_NAMES = [
  CIO_ASK_USER_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME,
  CIO_REQUEST_FILES_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME
] as const
