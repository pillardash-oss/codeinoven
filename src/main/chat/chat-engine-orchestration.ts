import type {
  HarnessAccount,
  ModelProfile,
  PermissionLevel,
  ProviderCatalog,
  Thread,
  ThreadSettings,
  ThinkingLevel
} from '../../lib/types'
import type { OvenHarnessInventoryItem, OvenState } from '../../lib/ovens'
import { MODEL_PROFILE_PERMISSION_LEVELS } from '../../lib/model-profiles'
import { DEFAULT_HARNESS } from '../../lib/harness-default'
import {
  DEFAULT_THINKING_LEVEL,
  STANDARD_THINKING_PRESETS,
  resolveDefaultThinkingLevel
} from '../../lib/thinking-presets'
import { isRemoteOvenId, LOCAL_OVEN_ID } from '../../lib/ovens'
import { isThreadBusyStatus } from '../../lib/thread-status-policy'
import { listHarnesses } from '../agents/harness-registry'
import { ORCHESTRATION_STATUS_TOOL_NAME } from '../../lib/orchestration-tools'
import type {
  OrchestrationExecutor,
  OrchestrationToolContext
} from '../utilities/utility-orchestration-service'

/**
 * The main-process implementation behind the orchestration tools.
 *
 * Everything here is a plan over data the app already owns: the Oven registry,
 * the Oven harness inventory, the harness catalog, the provider catalogs, the
 * account registry and the saved model profiles. The module never guesses a
 * machine, a model or an account. It reads the real catalog, validates every id
 * a dispatch names against it, and refuses the call when the run could not
 * actually start.
 *
 * The dependencies are narrow functions rather than the owning services, so the
 * executor stays testable and the chat engine keeps ownership of thread
 * creation, prompt sending and the turn lifecycle.
 */

/** One dispatch this session started and has not yet reported on. */
export interface PendingOrchestrationDispatch {
  runThreadId: string
  requestingProjectId: string
  requestingThreadId: string
  title: string
  ovenName: string
  settings: ThreadSettings
  createdAt: number
}

/**
 * The dispatches still running, keyed by the thread they run on.
 *
 * A settled turn on a run thread is what the app steers back into the thread
 * that asked for it. The map is deliberately in memory: a dispatch is a live
 * instruction, and an app restart has no turn left to steer into, so the run
 * thread's own row and the user's notification carry the outcome from there.
 */
export class OrchestrationDispatches {
  private readonly pending = new Map<string, PendingOrchestrationDispatch>()

  remember(dispatch: PendingOrchestrationDispatch): void {
    this.pending.set(dispatch.runThreadId, dispatch)
  }

  /** Take and remove the dispatch for a run thread that just settled. */
  settle(runThreadId: string): PendingOrchestrationDispatch | undefined {
    const dispatch = this.pending.get(runThreadId)
    if (!dispatch) return undefined
    this.pending.delete(runThreadId)
    return dispatch
  }

  has(runThreadId: string): boolean {
    return this.pending.has(runThreadId)
  }
}

/** Everything the executor reads or performs, supplied by the chat engine. */
export interface OrchestrationDeps {
  /** The provider catalogs the model picker uses for a project. */
  listProviderCatalogs: (projectId: string) => Promise<ProviderCatalog[]>
  /** Every saved harness account, with `isDefault` on the user's chosen one. */
  listAccounts: () => Promise<HarnessAccount[]>
  /** Every configured Oven, plus the app's default. */
  listOvens: () => Promise<OvenState>
  /** The installed-harness inventory for one Oven (empty for this computer). */
  harnessInventory: (ovenId: string) => Promise<OvenHarnessInventoryItem[]>
  /** The saved model profiles the user named, in their own order. */
  listModelProfiles: () => Promise<ModelProfile[]>
  getThread: (projectId: string, threadId: string) => Promise<Thread | null>
  /** The last assistant text of a thread, for a status report. */
  latestAssistantText: (projectId: string, threadId: string) => Promise<string | null>
  /** Create a real project thread, in the same path a user-created one takes. */
  createThread: (input: {
    projectId: string
    title: string
    settings: ThreadSettings
  }) => Promise<Thread>
  /** Run a prompt on a thread, exactly as the app does for its own dispatch. */
  sendPrompt: (input: {
    projectId: string
    threadId: string
    settings: ThreadSettings
    text: string
  }) => Promise<void>
}

/** The executor plus the dispatch book the turn lifecycle reads. */
export interface OrchestrationRuntime {
  executor: OrchestrationExecutor
  dispatches: OrchestrationDispatches
}

export function createOrchestrationRuntime(deps: OrchestrationDeps): OrchestrationRuntime {
  const dispatches = new OrchestrationDispatches()
  return { dispatches, executor: createOrchestrationExecutor(deps, dispatches) }
}

export function createOrchestrationExecutor(
  deps: OrchestrationDeps,
  dispatches: OrchestrationDispatches
): OrchestrationExecutor {
  return async (operation, input, context) => {
    switch (operation) {
      case 'targets':
        return readTargets(deps, input, context)
      case 'dispatch':
        return dispatchWork(deps, dispatches, input, context)
      case 'status':
        return readStatus(deps, input, context)
      default:
        throw new Error(`Unknown orchestration operation: ${operation}`)
    }
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  return stringValue(input[key])
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key)
  if (!value) throw new Error(`The ${key} field is required.`)
  return value
}

/**
 * The workstation as the agent needs to see it: machines and what they run,
 * the harness catalog, the models and their thinking levels, the accounts with
 * the default marked, and the saved profiles.
 */
async function readTargets(
  deps: OrchestrationDeps,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const harnessFilter = optionalString(input, 'harnessId')
  const ovenFilter = optionalString(input, 'ovenId')
  const includeModels = input['includeModels'] !== false

  const [state, catalogs, accounts, profiles] = await Promise.all([
    deps.listOvens(),
    includeModels ? deps.listProviderCatalogs(context.projectId) : Promise.resolve([]),
    deps.listAccounts(),
    deps.listModelProfiles()
  ])

  const ovens = state.ovens
    .filter((oven) => !ovenFilter || oven.id === ovenFilter)
    .map((oven) => ({
      id: oven.id,
      name: oven.name,
      kind: oven.kind,
      host: oven.connection?.host,
      user: oven.connection?.user,
      port: oven.connection?.port,
      connected: oven.connectionStatus?.state === 'connected',
      isDefault: oven.id === state.defaultOvenId
    }))

  const inventory = await Promise.all(
    ovens.map(async (oven) => ({
      ovenId: oven.id,
      hasHarnessData: oven.kind === 'ssh',
      harnesses: await deps.harnessInventory(oven.id)
    }))
  )

  const accountsForHarness = harnessFilter
    ? accounts.filter((account) => account.harnessId === harnessFilter)
    : accounts

  const catalogsForHarness = harnessFilter
    ? catalogs.filter((catalog) => catalog.harnessId === harnessFilter)
    : catalogs

  return {
    project: { id: context.projectId, path: context.projectPath },
    defaults: {
      ovenId: state.defaultOvenId,
      harnessId: DEFAULT_HARNESS,
      thinkingLevel: DEFAULT_THINKING_LEVEL
    },
    ovens,
    ovenInventory: inventory.map((entry) => ({
      ovenId: entry.ovenId,
      // This computer is never probed the way a remote Oven is; the composer
      // treats its harnesses as selectable without a probe too.
      probed: entry.hasHarnessData,
      harnesses: entry.harnesses.map((item) => ({
        harnessId: item.harnessId,
        health: item.health,
        installedVersion: item.installedVersion
      }))
    })),
    harnesses: listHarnesses().map((harness) => ({ id: harness.id, name: harness.name })),
    models: catalogsForHarness.map((catalog) => ({
      harnessId: catalog.harnessId,
      providerId: catalog.id,
      providerName: catalog.name,
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        thinkingLevels: model.thinkingPresets?.map((preset) => preset.id) ?? [],
        fastSupported: model.fastSupported === true,
        ultrafastSupported: model.ultrafastSupported === true
      }))
    })),
    thinkingLevels: STANDARD_THINKING_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label
    })),
    accounts: accountsForHarness.map((account) => ({
      id: account.id,
      harnessId: account.harnessId,
      providerId: account.providerId,
      label: account.label,
      isDefault: account.isDefault === true
    })),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      harnessId: profile.harnessId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
      inferenceMode: profile.inferenceMode ?? 'normal',
      accountId: profile.accountId
    })),
    notes: {
      idsAreExact:
        'Every id returned here is the exact value cio_orchestrate_dispatch accepts. Never invent one.',
      localHarnessAvailability:
        'This computer is not probed for installed harnesses; a remote Oven reports health per harness.'
    }
  }
}

/** Resolve and start a real run, refusing anything the catalog does not confirm. */
async function dispatchWork(
  deps: OrchestrationDeps,
  dispatches: OrchestrationDispatches,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const title = requiredString(input, 'title')
  const prompt = requiredString(input, 'prompt')
  const harnessId = requiredString(input, 'harnessId')
  const providerId = requiredString(input, 'providerId')
  const modelId = requiredString(input, 'modelId')
  const projectId = optionalString(input, 'projectId') ?? context.projectId
  const ovenId = optionalString(input, 'ovenId') ?? LOCAL_OVEN_ID
  const ovenPath = optionalString(input, 'ovenPath')
  const accountId = optionalString(input, 'accountId')

  const harness = listHarnesses().find((candidate) => candidate.id === harnessId)
  if (!harness) throw new Error(`Unknown harness "${harnessId}". Read cio_orchestrate_targets.`)

  const [catalogs, accounts, state, requestingThread] = await Promise.all([
    deps.listProviderCatalogs(projectId),
    deps.listAccounts(),
    deps.listOvens(),
    deps.getThread(context.projectId, context.threadId)
  ])

  const catalog = catalogs.find(
    (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
  )
  const model = catalog?.models.find((candidate) => candidate.id === modelId)
  if (!catalog || !model) {
    throw new Error(
      `The ${harnessId} catalog has no ${providerId}/${modelId} model. Read cio_orchestrate_targets for the exact ids.`
    )
  }

  const oven = state.ovens.find((candidate) => candidate.id === ovenId)
  if (!oven) throw new Error(`Unknown Oven "${ovenId}". Read cio_orchestrate_targets.`)

  if (isRemoteOvenId(ovenId)) {
    const inventory = await deps.harnessInventory(ovenId)
    const item = inventory.find((entry) => entry.harnessId === harnessId)
    if (
      item &&
      (item.health === 'missing' || item.health === 'broken' || item.health === 'unsupported')
    ) {
      throw new Error(
        `The Oven "${oven.name}" cannot run ${harness.name}: its inventory reports ${item.health}. Pick a machine that has it, or ask the user.`
      )
    }
  }

  const account = resolveAccount(accounts, harnessId, accountId)
  const thinkingLevel =
    resolveThinkingLevel(
      input,
      model.thinkingPresets?.map((preset) => preset.id)
    ) ?? DEFAULT_THINKING_LEVEL
  const inferenceMode = optionalString(input, 'inferenceMode')
  // A dispatch always runs under a real permission tier: the one the agent
  // named, the one the requesting thread already runs with, or the app default.
  const permissionLevel: PermissionLevel =
    resolvePermissionLevel(input['permissionLevel']) ??
    requestingThread?.settings?.permissionLevel ??
    'auto_review'

  const settings: ThreadSettings = {
    harnessId,
    providerId,
    modelId,
    accountId: account.id,
    thinkingLevel,
    ...(inferenceMode ? { inferenceMode: inferenceMode as ThreadSettings['inferenceMode'] } : {}),
    permissionLevel,
    ovenId,
    ...(ovenPath ? { ovenPath } : {})
  }

  const thread = await deps.createThread({ projectId, title, settings })
  dispatches.remember({
    runThreadId: thread.id,
    requestingProjectId: context.projectId,
    requestingThreadId: context.threadId,
    title,
    ovenName: oven.name,
    settings,
    createdAt: Date.now()
  })

  await deps.sendPrompt({ projectId, threadId: thread.id, settings, text: prompt })

  return {
    status: 'dispatched',
    threadId: thread.id,
    projectId,
    title: thread.title,
    oven: { id: oven.id, name: oven.name, kind: oven.kind },
    harness: { id: harness.id, name: harness.name },
    model: {
      providerId: catalog.id,
      providerName: catalog.name,
      modelId: model.id,
      name: model.name
    },
    thinkingLevel,
    account: { id: account.id, label: account.label },
    note: 'The run has been accepted, not finished. The app reports its outcome into this conversation when the thread settles.'
  }
}

/** One dispatched thread's current state, and its latest result when settled. */
async function readStatus(
  deps: OrchestrationDeps,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const threadId = requiredString(input, 'threadId')
  const projectId = optionalString(input, 'projectId') ?? context.projectId
  const thread = await deps.getThread(projectId, threadId)
  if (!thread) throw new Error(`No thread "${threadId}" in this project.`)

  const ovenId = thread.settings?.ovenId ?? LOCAL_OVEN_ID
  const state = ovenId === LOCAL_OVEN_ID ? undefined : await deps.listOvens()
  const ovenName = state?.ovens.find((oven) => oven.id === ovenId)?.name ?? 'this computer'
  const busy = isThreadBusyStatus(thread.status)

  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    running: busy,
    oven: { id: ovenId, name: ovenName },
    model: thread.settings
      ? {
          harnessId: thread.settings.harnessId,
          providerId: thread.settings.providerId,
          modelId: thread.settings.modelId,
          thinkingLevel: thread.settings.thinkingLevel
        }
      : null,
    ...(busy ? {} : { result: await deps.latestAssistantText(projectId, thread.id) })
  }
}

/**
 * The account a dispatch runs under.
 *
 * A named account must exist for the harness; an unnamed one falls back to the
 * account the app marks as default, and then to the harness default. The caller
 * is expected to have asked the user when the harness has no default and none
 * was named, so reaching the harness default here is a definite choice, never a
 * silent substitution between two real accounts.
 */
function resolveAccount(
  accounts: readonly HarnessAccount[],
  harnessId: string,
  accountId: string | undefined
): HarnessAccount {
  const forHarness = accounts.filter((account) => account.harnessId === harnessId)
  if (accountId) {
    const named = forHarness.find((account) => account.id === accountId)
    if (!named) throw new Error(`Unknown account "${accountId}" for ${harnessId}.`)
    return named
  }
  const preferred = forHarness.find((account) => account.isDefault === true) ?? forHarness[0]
  if (preferred) return preferred
  // A harness with no managed account still runs under its synthetic default,
  // which is what the composer does when the picker has nothing to show.
  return {
    id: `${harnessId}.default`,
    harnessId,
    providerId: '',
    providerName: harnessId,
    label: 'Default',
    containerKind: 'legacy-default',
    createdAt: 0,
    updatedAt: 0
  }
}

/** The named permission tier, or undefined when the caller did not name one. */
function resolvePermissionLevel(value: unknown): PermissionLevel | undefined {
  const named = stringValue(value)
  if (!named) return undefined
  if (!MODEL_PROFILE_PERMISSION_LEVELS.includes(named as PermissionLevel)) {
    throw new Error(
      `Unknown permission level "${named}". Use one of: ${MODEL_PROFILE_PERMISSION_LEVELS.join(', ')}.`
    )
  }
  return named as PermissionLevel
}

/** The named thinking level, or the model's own default when it was omitted. */
function resolveThinkingLevel(
  input: Record<string, unknown>,
  offered: readonly string[] | undefined
): ThinkingLevel | undefined {
  const named = optionalString(input, 'thinkingLevel')
  if (named) {
    if (offered && offered.length > 0 && !offered.includes(named)) {
      throw new Error(
        `This model does not offer the "${named}" thinking level. It offers: ${offered.join(', ')}.`
      )
    }
    return named as ThinkingLevel
  }
  return resolveDefaultThinkingLevel(
    offered?.map((id) => ({ id, label: id })),
    undefined,
    undefined
  )
}

/**
 * The prompt the app sends into the thread that asked for a dispatch, once the
 * run settles. It runs as an internal turn there, so the agent reports the
 * outcome in its own words and the user sees the answer land where they asked
 * for it instead of only on a row they have to go find.
 */
export function buildOrchestrationReportPrompt(
  dispatch: PendingOrchestrationDispatch,
  status: string
): string {
  const outcome =
    status === 'completed'
      ? 'finished successfully'
      : status === 'failed'
        ? 'failed'
        : status === 'interrupted'
          ? 'was interrupted'
          : `settled with status "${status}"`
  return [
    `The work you dispatched as "${dispatch.title}" on ${dispatch.ovenName} has ${outcome}.`,
    `Read that thread with ${ORCHESTRATION_STATUS_TOOL_NAME} (threadId ${dispatch.runThreadId}) and report its result to the user.`,
    'Do not dispatch anything new, and do not start the work again.'
  ].join(' ')
}
