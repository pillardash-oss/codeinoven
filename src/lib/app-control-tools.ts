import type { GatewayToolDefinition } from './gateway-tools'

/**
 * The app-control tools: how an `@cio-hey` agent works the app itself.
 *
 * Where the orchestration tools place work on a machine, these reach everything
 * else a person can do in the app without touching the screen: every IPC channel
 * a panel or menu calls, and the renderer-local actions (navigate, open a panel,
 * open the browser) that are not channels at all. Together they are the answer
 * to "if a human can do it, the agent should be able to do it".
 *
 * Gating is the gateway's, not prose's: these routes are placed on a turn only
 * when it carries the `@cio-hey` tag, so an ordinary chat cannot drive the app.
 */

/** Read the app surface the agent may drive: channel domains and UI actions. */
export const APP_CONTROL_CATALOG_TOOL_NAME = 'cio_app_catalog'
/** Invoke one app IPC channel, or run one renderer UI action. */
export const APP_CONTROL_CALL_TOOL_NAME = 'cio_app_call'

/** Every app-control tool name, for gate checks and the Pi extension. */
export const APP_CONTROL_TOOL_NAMES: readonly string[] = [
  APP_CONTROL_CATALOG_TOOL_NAME,
  APP_CONTROL_CALL_TOOL_NAME
]

/** Whether a gateway tool name belongs to the app-control family. */
export function isAppControlTool(name: string): boolean {
  return APP_CONTROL_TOOL_NAMES.includes(name)
}

/**
 * The result shape every app-control operation answers with.
 *
 * Deliberately open: a channel's own result is forwarded exactly as it arrived,
 * because the point is to hand the agent the app's real answer, not a reshape.
 */
const APP_CONTROL_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
}

const CATALOG_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    domain: {
      type: 'string',
      description:
        'Limit the channel list to one domain, e.g. git, deployment, cloudDeploy, browser, providers, thread, project, config. Omit to read every domain.'
    },
    includeChannels: {
      type: 'boolean',
      description:
        'Include the app IPC channel names. Defaults to true. Send false when you only need the UI actions and the current context.'
    }
  },
  additionalProperties: false
}

const CALL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    channel: {
      type: 'string',
      description:
        'Exact app IPC channel to invoke, from cio_app_catalog, e.g. git:status, deployment:overview, browser:createTab. Pass the arguments in their declared order in `args`.'
    },
    args: {
      type: 'array',
      description:
        'Positional arguments for the channel, in the order the channel expects them. Omit or send [] for a channel that takes none.',
      items: {}
    },
    action: {
      type: 'string',
      description:
        'Renderer UI action id from cio_app_catalog, e.g. app.navigate, settings.open, panel.open, browser.open. Use this for effects that have no IPC channel.'
    },
    params: {
      type: 'object',
      description: 'Named parameters for the UI action, as listed by cio_app_catalog.',
      additionalProperties: true
    },
    destructiveConfirmed: {
      type: 'boolean',
      description:
        'Set true only after the user has agreed to a destructive operation. A destructive channel or action is refused without it.'
    }
  },
  additionalProperties: false
}

export const APP_CONTROL_TOOLS: GatewayToolDefinition[] = [
  {
    name: APP_CONTROL_CATALOG_TOOL_NAME,
    description:
      'Read the CodeInOven app surface an @cio-hey agent may drive: the app IPC channels grouped by domain (git, deployment, cloudDeploy, browser, providers, thread, project, config and more), the declared argument order for the channels that matter most (`channelArgs`), the renderer UI actions (navigate, open a panel, open the browser, open a project or thread), and the current project and thread. Call this before cio_app_call: it is the only source of the exact channel names and action ids.',
    inputSchema: CATALOG_INPUT_SCHEMA,
    outputSchema: APP_CONTROL_RESULT_SCHEMA,
    route: '/app-catalog',
    sentWhen: 'An @cio-hey turn, before driving an app rail, panel, browser or setting'
  },
  {
    name: APP_CONTROL_CALL_TOOL_NAME,
    description:
      'Do something in the CodeInOven app exactly as the user would: invoke one app IPC channel with `channel` (+ positional `args`), or run one renderer UI action with `action` (+ named `params`). This covers every rail and panel: read git status and history, watch deployments, commit and branch, open a panel or a settings section, open the global browser to a URL, open a project or thread, read or update config. It is the escape hatch that means the agent never needs screen control to operate the app. Use only names read from cio_app_catalog. A destructive operation is refused unless you first ask the user and then pass destructiveConfirmed: true.',
    inputSchema: CALL_INPUT_SCHEMA,
    outputSchema: APP_CONTROL_RESULT_SCHEMA,
    route: '/app-call',
    sentWhen: 'An @cio-hey turn once the channel or UI action to use is known'
  }
]
