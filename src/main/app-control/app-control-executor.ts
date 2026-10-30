import { IPC_INVOKE_CONTRACT } from '../../lib/ipc-contract'
import type { AppControlActionSummary, AppControlTarget } from '../../lib/app-control'
import type { PermissionLevel } from '../../lib/types'
import { captureAppWindow, requestAppControl } from './app-control-bridge'

/**
 * The plan behind the app-control tools.
 *
 * Two sources make up what an agent may drive: the app's own IPC channels, which
 * are read straight off the compiled contract (`IPC_INVOKE_CONTRACT` is a real
 * object, so its keys are the live channel names), and the renderer's UI
 * actions, which main can only learn by asking the renderer. Both are validated
 * before anything runs: an unknown channel or action is refused, and a
 * destructive one is refused until the agent says the user agreed.
 *
 * The channel list is the guarantee that this is not a curated subset. If a
 * panel or menu can call a channel, the agent can call it too, because the list
 * is the contract itself rather than a hand-kept mirror of it.
 */

/** What the current conversation is scoped to, for the catalog's context block. */
export interface AppControlContext {
  projectId: string
  projectPath: string | null
  threadId: string
  permissionLevel: PermissionLevel
}

export interface AppControlExecutor {
  catalog: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
  call: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
}

/**
 * Config fields the user owns alone, stripped from every agent-driven patch.
 *
 * `agentDefaults.pawn` picks the model a pawn agent runs on. An agent spawns a
 * pawn on its own model when the value is unset, so it never has a reason to
 * write it, and a default that an agent could repoint would stop meaning what
 * the user chose. The settings page writes it through the same
 * `config:update` channel, so the field is only removed here, at the
 * agent-facing door.
 */
function withoutUserOwnedConfig(patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const candidate = patch as Record<string, unknown>
  const agentDefaults = candidate['agentDefaults']
  if (typeof agentDefaults !== 'object' || agentDefaults === null || Array.isArray(agentDefaults))
    return patch
  const defaults = { ...(agentDefaults as Record<string, unknown>) }
  if (!('pawn' in defaults)) return patch
  delete defaults['pawn']
  return { ...candidate, agentDefaults: defaults }
}

/**
 * Words that mark a channel or action as destructive.
 *
 * Deliberately conservative in the blocking direction: a false positive costs
 * one confirmation, a false negative lets an agent delete or discard without the
 * user agreeing. A destructive call is refused unless the agent sets
 * `destructiveConfirmed`, which the contract tells it to set only after asking.
 */
const DESTRUCTIVE_KEYWORDS = [
  'delete',
  'remove',
  'destroy',
  'discard',
  'reset',
  'revert',
  'restore',
  'purge',
  'uninstall',
  'truncate',
  'quit',
  'terminate',
  'kill',
  'rollback',
  'overwrite',
  'force',
  'drop',
  'clear',
  'cancel',
  'abort'
] as const

const CHANNEL_NAMES: readonly string[] = Object.keys(IPC_INVOKE_CONTRACT)

/**
 * The declared argument order of the channels an agent is most likely to drive.
 *
 * Channel contracts carry types only, so the runtime has no argument names to
 * hand over. This is a curated hint map for the rails named most often (git,
 * deployments, cloud deployments, browser, providers, projects, config); a
 * channel without a hint still takes its arguments in declared order, and the
 * call answers with a type error when they are wrong.
 */
const CHANNEL_ARG_HINTS: Readonly<Record<string, string>> = {
  'git:status': 'projectId, scopeBucketId?',
  'git:diff': 'projectId, relativePath, staged (boolean), scopeBucketId?',
  'git:branches': 'projectId, scopeBucketId?',
  'git:log': 'projectId, limit?, offset?, query?, scopeBucketId?',
  'git:commitDiff': 'projectId, hash, scopeBucketId?',
  'git:stage': 'projectId, paths (string[]), scopeBucketId?',
  'git:unstage': 'projectId, paths (string[]), scopeBucketId?',
  'git:commit': 'projectId, message, scopeBucketId?',
  'git:amend': 'projectId, message, scopeBucketId?',
  'git:checkout': 'projectId, branch, scopeBucketId?',
  'git:createBranch': 'projectId, name, scopeBucketId?',
  'git:restoreFiles': 'projectId, source, paths (string[]), target, scopeBucketId?',
  'git:reset': 'projectId, mode, target?, scopeBucketId?',
  'git:getIdentity': 'projectId, scopeBucketId?',
  'git:remotes': 'projectId, scopeBucketId?',
  'deployment:activity': 'projectId, owner, repo',
  'deployment:runs': 'projectId, owner, repo, filter (all|failed|succeeded), page',
  'deployment:deployments': 'projectId, owner, repo, page',
  'deployment:detail': 'projectId, owner, repo, deploymentId',
  'deployment:runDetail': 'projectId, owner, repo, runId',
  'deployment:jobLog': 'projectId, owner, repo, jobId',
  'deployment:rerunRun': 'projectId, owner, repo, runId, mode',
  'deployment:cancelRun': 'projectId, owner, repo, runId',
  'cloudDeploy:getConfig': 'projectId',
  'cloudDeploy:listAccounts': 'no arguments',
  'cloudDeploy:overview': 'projectId, providerKind',
  'cloudDeploy:availableContainers': 'projectId, providerKind, accountId?',
  'cloudDeploy:containerStatus': 'projectId, providerKind, containerId, accountId?',
  'cloudDeploy:deployments': 'projectId, providerKind, containerId, accountId?',
  'cloudDeploy:containerLog': 'projectId, providerKind, containerId, deploymentId?, accountId?',
  'browser:loadTabs': 'no arguments',
  'providers:getStatus': 'no arguments',
  'project:list': 'no arguments',
  'thread:listRecentPerProject': 'no arguments',
  'thread:create':
    'a single input object: { projectId, providerId (the harness id, e.g. "pi"), title, workingDirectory?, settings?, scopeBucketId? }. This creates an empty thread: prefer cio_orchestrate_dispatch, which creates the thread and sends its first prompt in one call.',
  'agent:sendPrompt':
    'projectId, threadId, settings (ThreadSettings), text, attachments (array, may be []), specAction (null), userMessageId (an id you generate), promptContext?, promptReferences?, projectReferences?, presentation?, taskReferences?',
  'agent:listProviderSnapshot': 'projectId',
  'agent:refreshProviderCatalog':
    'projectId, options? ({ force?, refreshModelCatalogs? }). Run it when the catalog looks empty before concluding a model id is wrong.',
  'config:get': 'no arguments',
  'config:update': 'patch (AppConfigPatch)',
  'projectFiles:ide':
    'projectId, request ({ owner, action, path, serverId? }) and optional scopeBucketId. `action: "inventory" | "install" | "check"` take an empty path; `owner` is any unique label for the editor client.',
  'shell:openExternal': 'url'
}

/** The domain a channel belongs to, i.e. the text before its first `:`. */
function channelDomain(channel: string): string {
  const separator = channel.indexOf(':')
  return separator === -1 ? 'other' : channel.slice(0, separator)
}

/** Whether a channel or action id reads as destructive. */
export function isDestructiveAppControl(name: string): boolean {
  const normalized = name.toLowerCase()
  return DESTRUCTIVE_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

/** The channels, grouped by their domain prefix. */
function channelsByDomain(): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const channel of CHANNEL_NAMES) {
    const domain = channelDomain(channel)
    const list = groups.get(domain)
    if (list) list.push(channel)
    else groups.set(domain, [channel])
  }
  for (const list of groups.values()) list.sort()
  return groups
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function createAppControlExecutor(
  openBrowser?: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
): AppControlExecutor {
  const groups = channelsByDomain()

  const actions = async (): Promise<AppControlActionSummary[]> => {
    try {
      return await requestAppControl<AppControlActionSummary[]>({ kind: 'actions' })
    } catch {
      // A renderer that cannot answer lists no actions; the channel half of the
      // catalog still stands, so this is not a hard failure.
      return []
    }
  }

  const catalog = async (
    input: Record<string, unknown>,
    context: AppControlContext
  ): Promise<unknown> => {
    const domain = readString(input, 'domain')
    const includeChannels = input['includeChannels'] !== false
    const uiActions = (await actions()).map((entry) =>
      entry.id === 'browser.open' && openBrowser
        ? {
            ...entry,
            description:
              'Open a URL in a thread-owned background browser tab. attention="focus" reveals it when foreground interaction is needed. Returns the tab context.',
            params: [...entry.params, 'attention?']
          }
        : entry
    )

    const domains = includeChannels
      ? Array.from(groups, ([name, channels]) => ({
          name,
          count: channels.length,
          channels: domain === null || domain === name ? channels : []
        })).filter((entry) => domain === null || entry.name === domain)
      : []

    const channelArgs = includeChannels
      ? Object.fromEntries(
          Object.entries(CHANNEL_ARG_HINTS).filter(
            ([channel]) => domain === null || channelDomain(channel) === domain
          )
        )
      : {}

    return {
      context,
      controlPolicy:
        'Try background IPC/data operations first. UI-only navigation and panel actions remain available as foreground fallback. browser.open defaults to a thread-owned background tab; params.attention="focus" explicitly reveals it.',
      windowCapture:
        'The interface only exists inside Electron, so the in-app browser cannot render it. Pass capture: true to this tool to see the live app window as an image and verify what you changed.',
      destructiveChannels: CHANNEL_NAMES.filter((channel) => isDestructiveAppControl(channel)),
      recipes: {
        startAThreadWithMessage:
          'Read cio_orchestrate_targets, then call cio_orchestrate_dispatch with a target project id: it creates the thread and sends its first prompt in one call, for this project or any other one in `projects`. Use thread:create plus agent:sendPrompt only when the thread must open empty.',
        targetAnotherProject:
          "context.projectId is this thread's project. `project:list` names every project, and most channels take a projectId argument, so a different project needs no new thread."
      },
      domains,
      channelArgs,
      actions: uiActions
    }
  }

  const call = async (
    input: Record<string, unknown>,
    context: AppControlContext
  ): Promise<unknown> => {
    const channel = readString(input, 'channel')
    const action = readString(input, 'action')
    // Seeing the app is neither a channel nor a UI action: the interface only
    // exists inside Electron, so the capture is the one way an agent can look at
    // what it just changed instead of concluding the app is unverifiable.
    if (input['capture'] === true) {
      return { ok: true, result: await captureAppWindow() }
    }
    if (channel === null && action === null) {
      throw new Error('Provide either a `channel`, an `action`, or `capture: true`.')
    }
    const confirmed = input['destructiveConfirmed'] === true

    let target: AppControlTarget
    if (channel !== null) {
      if (!CHANNEL_NAMES.includes(channel)) {
        throw new Error(
          `Unknown app channel "${channel}". Read cio_app_catalog for the exact names.`
        )
      }
      const rawArgs = input['args']
      if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
        throw new Error('`args` must be an array of positional channel arguments.')
      }
      const args = Array.isArray(rawArgs) ? rawArgs : []
      if (!confirmed && isDestructiveAppControl(channel)) {
        throw new Error(
          `"${channel}" is a destructive operation. Ask the user to confirm, then call again with destructiveConfirmed: true.`
        )
      }
      const safeArgs = channel === 'config:update' ? args.map(withoutUserOwnedConfig) : args
      target = { kind: 'channel', channel, args: safeArgs }
    } else if (action !== null) {
      const known = await actions()
      const match = known.find((entry) => entry.id === action)
      if (!match) {
        throw new Error(`Unknown UI action "${action}". Read cio_app_catalog for the exact ids.`)
      }
      if (!confirmed && isDestructiveAppControl(action)) {
        throw new Error(
          `"${action}" is a destructive operation. Ask the user to confirm, then call again with destructiveConfirmed: true.`
        )
      }
      const rawParams = input['params']
      const params =
        typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {}
      if (action === 'browser.open' && openBrowser) {
        const result = await openBrowser(params, context)
        return { ok: true, result }
      }
      target = { kind: 'action', action, params }
    } else {
      throw new Error('Provide either a `channel`, an `action`, or `capture: true`.')
    }

    const result = await requestAppControl(target)
    return { ok: true, result }
  }

  return { catalog, call }
}
