/**
 * Generated TypeScript source for the app-owned Pi core-tools extension.
 *
 * Pi has no native question, todo, file-request, or permission-card tools.
 * This extension closes that gap with three custom tools plus a tool-call
 * permission gate:
 *
 *  - `cio_ask_user`        structured multi-question ask rendered by the app's
 *                          question cards through the extension-UI protocol.
 *  - `cio_todo_write`      todo tracking; the name and `{ todos: [...] }`
 *                          input shape match the renderer's todo-tool
 *                          detection, so AgentTodoCard works unchanged.
 *  - `cio_request_files`   asks the user for file paths, validates them, and
 *                          returns a structured file list for the agent.
 *  - `cio_agent_status`    polls or waits for the sub-agent worker threads.
 *  - `cio_agent_output`    reads the final output of finished workers.
 *
 * The permission gate intercepts every built-in tool call via
 * `pi.on('tool_call')` and evaluates it against an OpenCode-style
 * "flat out denied" list (recursive deletes, destructive git operations,
 * privileged/system commands, piped shell downloads, and any file access
 * outside the project cwd). A denied-category call pauses on
 * `ctx.ui.confirm(...)` whose message carries a `cio-permission:` marker with
 * structured JSON metadata; the driver upgrades that dialog into a real
 * `permission.asked` event so the renderer shows the standard permission card
 * and the chat engine's PermissionPolicy enrichment (risk, reason, auto-reply
 * in full-access mode) keeps working unchanged.
 *
 * The marker constants are shared with the driver: `CIO_PERMISSION_MARKER`
 * for permission dialogs, `CIO_SUBAGENT_MARKER` for sub-agent progress
 * streamed through tool-execution updates, and `CIO_QUESTION_MARKER` for
 * question dialogs carrying the scope header separately from the question
 * text (pi's dialog signature has a single title string).
 *
 * Sub-agents: `cio_spawn_agent` opens a nested in-process pi session (a
 * persistent worker "thread" controlled by the primary agent). Sub-agents
 * get gated wrappers around the built-in tools   never the spawn tool, so
 * they cannot recurse   inherit the primary's model/thinking level unless
 * overridden per spawn, and bubble every permission request up to the
 * primary thread through the parent extension-UI context. Permission cards
 * are pure UI on the primary thread: the primary agent's context only ever
 * receives the sub-agent's final message, never its transcript.
 * A session that publishes a tool allowlist (audits, read-only prompt turns,
 * filesystem-off chat, brainstorm turns) never gets the sub-agent tools, and
 * pi drops an inactive tool from the request, so their descriptions and
 * guidelines leave the prompt as well.
 * Status and output are deliberately two tools. `cio_agent_status` answers
 * "is it still running?" with metadata only (id, purpose, status, error), so
 * polling never injects a finished worker's output into the primary agent's
 * context; `cio_agent_output` fetches the final message of the finished ids
 * the primary actually wants to read, as `agentId -> final output` pairs.
 *
 * Background sub-agents announce completion to the primary agent through a
 * display:false custom message delivered with pi.sendMessage   steer while
 * the primary is streaming, a fresh turn when it is idle. The model sees
 * the notification and final output as a user-role context message, but it
 * never renders in the transcript: the driver ignores custom-role messages.
 *
 * Completion reporting: workers track every file they edit or write (and
 * are instructed to list shell-created files), and those paths accompany the
 * result and notification because the primary agent owns committing. An
 * agent_settled guard wakes the primary with a fresh turn whenever it tries
 * to end its work while sub-agents are still running.
 *
 * Stopping: pi's abort RPC only reaches the root run, so the nested worker
 * sessions can never be addressed by the app directly. The driver therefore
 * publishes a stop request into this session's stop-flag file whenever the
 * user stops the thread (or one worker), and this extension applies it: every
 * live worker is aborted, reports `aborted` instead of a completion, and is
 * barred from waking the primary. The same request disarms the turn-end guard,
 * which would otherwise start a fresh primary turn right after the stop.
 */

export { PI_CORE_TOOLS_TOOL_NAMES } from '../../lib/core-tools'

import { piCoreToolsHeaderSource } from './pi/tools/core-tools-header'
import { piCoreToolsInteractiveSource } from './pi/tools/core-tools-interactive'
import { piCoreToolsSubagentSource } from './pi/tools/core-tools-subagents'
import { piCoreToolsEventsSource } from './pi/tools/core-tools-events'
export const CIO_PERMISSION_MARKER = 'cio-permission:'
export const CIO_SUBAGENT_MARKER = 'cio-subagent:'
export const CIO_QUESTION_MARKER = 'cio-question:'

/**
 * Compose the generated Pi core-tools extension module from its grouped
 * fragments. The fragments are concatenated in order with no separator, so the
 * emitted source is byte-for-byte identical to the original single template.
 * `questionCap` feeds the app-configured cio_ask_user question cap.
 */
export function piCoreToolsExtension(options: { questionCap: number }): string {
  return [
    piCoreToolsHeaderSource(),
    piCoreToolsInteractiveSource(options.questionCap),
    piCoreToolsSubagentSource(),
    piCoreToolsEventsSource()
  ].join('')
}
