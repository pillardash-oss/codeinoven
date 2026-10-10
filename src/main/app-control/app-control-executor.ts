import { IPC_INVOKE_CONTRACT } from '../../lib/ipc-contract'
import type { AppControlActionSummary, AppControlTarget } from '../../lib/app-control'
import { requestAppControl } from './app-control-bridge'

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
}

export interface AppControlExecutor {
  catalog: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
  call: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
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
  'deployment:overview': 'projectId, owner, repo',
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
  'config:get': 'no arguments',
  'config:update': 'patch (AppConfigPatch)',
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

export function createAppControlExecutor(): AppControlExecutor {
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
    const uiActions = await actions()

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
      destructiveChannels: CHANNEL_NAMES.filter((channel) => isDestructiveAppControl(channel)),
      domains,
      channelArgs,
      actions: uiActions
    }
  }

  const call = async (input: Record<string, unknown>): Promise<unknown> => {
    const channel = readString(input, 'channel')
    const action = readString(input, 'action')
    if (channel === null && action === null) {
      throw new Error('Provide either a `channel` or an `action` from cio_app_catalog.')
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
      target = { kind: 'channel', channel, args }
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
      target = { kind: 'action', action, params }
    } else {
      throw new Error('Provide either a `channel` or an `action` from cio_app_catalog.')
    }

    const result = await requestAppControl(target)
    return { ok: true, result }
  }

  return { catalog, call }
}
