/**
 * Generated TypeScript source for the app-owned Pi built-in-tool extension.
 *
 * The working trace labels a call with the action it performed, and for that it
 * reads an `action_summary` field from the call's own arguments. The app's own
 * tools declare it (see the utility gateway extension), but pi's built-in tools
 * do not: their schemas are the harness's, and a model cannot fill a field no
 * schema offers it.
 *
 * Pi keys its tool registry by name and writes extension registrations over the
 * built-in entry of the same name, so an extension CAN replace a built-in tool.
 * This one replaces them with the definitions pi builds for itself, from the
 * same factories and the same settings, adding only two things: the summary
 * field on the parameters, and one strip before the tool's own `execute` runs,
 * so no tool body ever sees a field that exists for the reader.
 *
 * Nothing about tool behaviour is reimplemented here, which is the whole point:
 * the moment the harness changes how `bash` truncates, how `read` handles
 * images, or which shell it spawns, this extension inherits the change because
 * it calls the same code.
 *
 * Two harness rules shape the shape of this module:
 *
 * - The definitions need the session's effective settings (a custom shell path
 *   must keep working), and pi's action methods throw during extension load, so
 *   the work happens on the first lifecycle event instead of at load.
 * - Registering a name activates it, and this session's tool set is already
 *   decided by then (a scoped worker, a one-shot prompt, a plan-only thread), so
 *   the active set is captured first and restored after, because an override
 *   that widened what the model can call would be a permission change.
 *
 * Defensive by design: a runtime that does not expose the factories keeps its
 * own tools, and a registration the registry refuses is dropped, because losing
 * a label is never worth losing a tool.
 */
export function piBaseToolsExtension(): string {
  return `import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent'
import { createFindToolDefinition } from '@earendil-works/pi-coding-agent'
import { createGrepToolDefinition } from '@earendil-works/pi-coding-agent'
import { createLsToolDefinition } from '@earendil-works/pi-coding-agent'
import { createPowerShellToolDefinition } from '@earendil-works/pi-coding-agent'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** The session working directory, injected when the module is materialized. */
const CIO_SESSION_CWD = __CIO_SESSION_CWD__

/** The field a model fills with the action the call performs. */
const ACTION_SUMMARY_KEY = 'action_summary'

const ACTION_SUMMARY_DESCRIPTION =
  'Always fill this in: one short phrase saying what this call accomplishes, shown to the user in place of the raw tool name.'

/** The summary field, declared on every built-in tool. */
const ACTION_SUMMARY_PARAMETERS: Record<string, unknown> = {
  [ACTION_SUMMARY_KEY]: Type.Optional(Type.String({ description: ACTION_SUMMARY_DESCRIPTION }))
}

/** The factories this override needs, so an older runtime is detected up front. */
const CIO_BASE_TOOL_FACTORIES = [
  createReadToolDefinition,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
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
   * Re-register pi's built-in tools with the action-summary field.
   *
   * The definitions are pi's own: the same eight per-tool factories its session
   * calls (its \`createAllToolDefinitions\` is exactly this mapping), with the two
   * options it passes read back from the effective settings, so a custom shell
   * path, a shell command prefix, or the image-resize preference behave exactly
   * as they do without this extension.
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
      createReadToolDefinition(CIO_SESSION_CWD, {
        autoResizeImages: settings.images?.autoResize ?? true
      }),
      createBashToolDefinition(CIO_SESSION_CWD, {
        commandPrefix: settings.shellCommandPrefix,
        shellPath: settings.shellPath
      }),
      createPowerShellToolDefinition(CIO_SESSION_CWD),
      createEditToolDefinition(CIO_SESSION_CWD),
      createWriteToolDefinition(CIO_SESSION_CWD),
      createGrepToolDefinition(CIO_SESSION_CWD),
      createFindToolDefinition(CIO_SESSION_CWD),
      createLsToolDefinition(CIO_SESSION_CWD)
    ]
    for (const definition of definitions) {
      if (!definition || typeof definition.execute !== 'function') continue
      const declared = (definition.parameters?.properties ?? {}) as Record<string, unknown>
      try {
        pi.registerTool({
          ...definition,
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
