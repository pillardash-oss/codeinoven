/**
 * Generated TypeScript source for the app-owned Pi built-in-tool extension.
 *
 * The working trace labels a call with the action it performed, and for that it
 * reads an `action_summary` field from the call's own arguments. The app's own
 * tools declare it (see the utility gateway extension), but pi's built-in tools
 * do not: their schemas are the harness's, and a model cannot fill a field no
 * schema offers it.
 *
 * Only the tools whose rows cannot describe themselves are replaced. A shell
 * call, a grep, a find and an ls read as a wall of flags and paths, so the
 * summary is what tells the reader what the agent was doing. A read, an edit and
 * a write already show the file they touched, and their diffs, so they are left
 * alone.
 *
 * Pi keys its tool registry by name and writes extension registrations over the
 * built-in entry of the same name, so an extension CAN replace a built-in tool.
 * This one replaces them with the definitions pi builds for itself, from the
 * same factories and the same settings, adding only two things: the summary
 * field on the parameters, and one strip before the tool's own `execute` runs,
 * so no tool body ever sees a field that exists for the reader.
 *
 * Nothing about tool behaviour is reimplemented here, which is the whole point:
 * the moment the harness changes how `bash` truncates its output or which shell
 * it spawns, this extension inherits the change because it calls the same code.
 *
 * Three harness rules shape the shape of this module:
 *
 * - The definitions need the session's effective settings (a custom shell path
 *   must keep working), and pi's action methods throw during extension load, so
 *   the work happens on the first lifecycle event instead of at load.
 * - Registering a name activates it, and this session's tool set is already
 *   decided by then (a scoped worker, a one-shot prompt, a plan-only thread), so
 *   the active set is captured first and restored after, because an override
 *   that widened what the model can call would be a permission change.
 * - Windows powershell belongs to the app, not to pi: it is registered at load
 *   with native operations, UTF-8 console encoding and its own timeouts, and
 *   re-registering the stock definition afterwards would silently undo all of
 *   it. That platform keeps pi's own tool.
 *
 * The field stays optional in the schema, because a missing label must never
 * fail a call. It is argued for instead: the parameter description and the
 * tool's own description both tell the model that this phrase is what the user
 * reads, in place of the raw command, which is the only reason it is worth
 * filling.
 *
 * Defensive by design: a runtime that does not expose the factories keeps its
 * own tools, and a registration the registry refuses is dropped, because losing
 * a label is never worth losing a tool.
 */
import { ACTION_SUMMARY_INPUT_KEY } from '../../lib/tool-action-label'

export function piBaseToolsExtension(): string {
  return `import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { createFindToolDefinition } from '@earendil-works/pi-coding-agent'
import { createGrepToolDefinition } from '@earendil-works/pi-coding-agent'
import { createLsToolDefinition } from '@earendil-works/pi-coding-agent'
import { createPowerShellToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** The session working directory, injected when the module is materialized. */
const CIO_SESSION_CWD = __CIO_SESSION_CWD__

/** The field a model fills with the action the call performs. Interpolated from
 *  the renderer's resolver so the schema and the label cannot disagree. */
const ACTION_SUMMARY_KEY = ${JSON.stringify(ACTION_SUMMARY_INPUT_KEY)}

/**
 * How the field is argued for on the parameter itself.
 *
 * A model reads parameter descriptions for every call it makes, so this is the
 * one place the request reaches it every time. It says what the reader gets and
 * gives two examples, because "describe your call" alone is what produced
 * unlabelled calls before.
 */
const ACTION_SUMMARY_DESCRIPTION =
  'Strongly recommended on every call: one short phrase in plain language saying what this command accomplishes for the user, for example "List the largest files in the repo" or "Check which tests fail". The user reads this phrase instead of the raw command, so a call without it explains nothing.'

/**
 * The same request, on the tool's own description.
 *
 * The parameter description is where the model looks once it has decided to
 * call the tool; the tool description is what it reads while choosing, which is
 * early enough for the label to shape the call it then makes.
 */
const ACTION_SUMMARY_DESCRIPTION_SUFFIX =
  '\\n\\nAlways include ' +
  ACTION_SUMMARY_KEY +
  ': a short phrase describing what you are doing, which the user reads in place of this raw call.'

/** The summary field, declared on every replaced tool. */
const ACTION_SUMMARY_PARAMETERS: Record<string, unknown> = {
  [ACTION_SUMMARY_KEY]: Type.Optional(Type.String({ description: ACTION_SUMMARY_DESCRIPTION }))
}

/** The factories this override needs, so an older runtime is detected up front. */
const CIO_BASE_TOOL_FACTORIES = [
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition
]

/**
 * One call's own arguments without the field that only labels the trace.
 *
 * A built-in tool destructures what it expects, so the key would be harmless
 * anyway; returning a copy keeps that true for a tool that inspects its own
 * argument object, and keeps the label out of anything the tool records.
 */
function withoutActionSummary(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  if (!(ACTION_SUMMARY_KEY in record)) return args
  const copy = { ...record }
  delete copy[ACTION_SUMMARY_KEY]
  return copy
}

export default function codeInOvenBaseToolsExtension(pi: ExtensionAPI): void {
  let applied = false

  /**
   * Re-register the tools whose rows cannot describe themselves.
   *
   * The definitions are pi's own: the same per-tool factories its session calls,
   * with the options it passes read back from the effective settings, so a
   * custom shell path or a shell command prefix behave exactly as they do
   * without this extension.
   */
  function applyActionSummaryToBaseTools(): void {
    if (applied) return
    if (!CIO_BASE_TOOL_FACTORIES.every((factory) => typeof factory === 'function')) return
    if (typeof pi.getSettings !== 'function' || typeof pi.getActiveTools !== 'function') return
    let settings
    try {
      settings = pi.getSettings()
    } catch {
      // Action methods throw during extension load: wait for the next event.
      return
    }
    applied = true
    // The session's tool set is already decided at this point. Registering a
    // name activates it, so remember the real set and put it back afterwards.
    const activeTools = pi.getActiveTools()
    const definitions = [
      createBashToolDefinition(CIO_SESSION_CWD, {
        commandPrefix: settings.shellCommandPrefix,
        shellPath: settings.shellPath
      }),
      createGrepToolDefinition(CIO_SESSION_CWD),
      createFindToolDefinition(CIO_SESSION_CWD),
      createLsToolDefinition(CIO_SESSION_CWD)
    ]
    // Only where the app does not own the tool itself. On Windows the app's
    // powershell replaces pi's at load, with native operations, UTF-8 console
    // encoding and its own timeouts; this hook runs later, so re-registering
    // the stock definition here would undo all of it.
    if (process.platform !== 'win32' && typeof createPowerShellToolDefinition === 'function') {
      definitions.push(createPowerShellToolDefinition(CIO_SESSION_CWD))
    }
    for (const definition of definitions) {
      if (!definition || typeof definition.execute !== 'function') continue
      const declared = (definition.parameters?.properties ?? {}) as Record<string, unknown>
      try {
        pi.registerTool({
          ...definition,
          description:
            typeof definition.description === 'string'
              ? definition.description + ACTION_SUMMARY_DESCRIPTION_SUFFIX
              : definition.description,
          parameters: Type.Object({ ...declared, ...ACTION_SUMMARY_PARAMETERS }),
          execute: (toolCallId, args, signal, onUpdate, ctx) =>
            definition.execute(toolCallId, withoutActionSummary(args), signal, onUpdate, ctx)
        })
      } catch {
        // A registry that refuses this name keeps its own tool, which is fine.
      }
    }
    if (typeof pi.setActiveTools === 'function') pi.setActiveTools(activeTools)
  }

  pi.on('session_start', () => {
    applyActionSummaryToBaseTools()
  })
  pi.on('before_agent_start', () => {
    applyActionSummaryToBaseTools()
  })
}
`
}
