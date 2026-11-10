import type {
  AgentSecretSubmission,
  HarnessAccount,
  ModelProfile,
  PermissionLevel,
  PermissionReply,
  ProviderCatalog,
  ProviderModel,
  Thread,
  ThreadDispatchOrigin,
  ThreadSettings,
  ThinkingLevel
} from '../../lib/types'
import type { OvenHarnessInventoryItem, OvenState } from '../../lib/ovens'
import {
  MODEL_PROFILE_INFERENCE_MODES,
  MODEL_PROFILE_PERMISSION_LEVELS
} from '../../lib/model-profiles'
import { DEFAULT_HARNESS } from '../../lib/harness-default'
import {
  DEFAULT_THINKING_LEVEL,
  STANDARD_THINKING_PRESETS,
  resolveDefaultThinkingLevel
} from '../../lib/thinking-presets'
import { isRemoteOvenId, LOCAL_OVEN_ID } from '../../lib/ovens'
import { isThreadBusyStatus } from '../../lib/thread-status-policy'
import { ASSISTANT_SPACE_ID } from '../../lib/types/project'
import type { Assistant } from '../../lib/types/assistant'
import { delegationAuthor, assistantCanDelegate } from './chat-engine-don'
import type { PendingDonDelegation } from './chat-engine-don'
import {
  acpHarnessDescriptors,
  ensureAcpAgentsLoaded,
  currentAcpAgents
} from '../drivers/acp/acp-agents-store'
import { listHarnesses } from '../agents/harness-registry'
import { Logger } from '../system/logger'
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

/** A project a dispatch may target, as the agent sees it. */
export interface ProjectTarget {
  id: string
  name: string
  path: string
}

/** Everything the executor reads or performs, supplied by the chat engine. */
export interface OrchestrationDeps {
  /** The provider catalogs the model picker uses for a project. */
  listProviderCatalogs: (projectId: string) => Promise<ProviderCatalog[]>
  /**
   * Discover a project's provider catalogs again, bypassing the snapshot the
   * model picker holds.
   *
   * A launch that has not discovered its catalogs yet reports every model id as
   * unknown, and `cio_orchestrate_targets` reads that same empty snapshot, so a
   * dispatch retries once through this instead of sending the agent in a circle.
   */
  refreshProviderCatalogs: (projectId: string) => Promise<ProviderCatalog[]>
  /** Every project the app knows, so a dispatch can name one other than this thread's. */
  listProjects: () => Promise<readonly ProjectTarget[]>
  /** Every saved harness account, with `isDefault` on the user's chosen one. */
  listAccounts: () => Promise<HarnessAccount[]>
  /** Every configured Oven, plus the app's default. */
  listOvens: () => Promise<OvenState>
  /** The installed-harness inventory for one Oven (empty for this computer). */
  harnessInventory: (ovenId: string) => Promise<OvenHarnessInventoryItem[]>
  /** The saved model profiles the user named, in their own order. */
  listModelProfiles: () => Promise<ModelProfile[]>
  getThread: (projectId: string, threadId: string) => Promise<Thread | null>
  /** A thread by id, whatever project it lives in, for continuing existing work. */
  getThreadById: (threadId: string) => Promise<Thread | null>
  /** Every thread this conversation dispatched, newest first, from the dispatch ledger. */
  listDispatchedThreads: (
    initiatorProjectId: string,
    initiatorThreadId: string
  ) => Promise<readonly Thread[]>
  /** Persist how an existing thread runs, so a change survives its next turn. */
  updateThreadSettings: (
    projectId: string,
    threadId: string,
    settings: ThreadSettings
  ) => Promise<unknown>
  /** Clear the user's stop latch when a follow-up resumes the thread on their behalf. */
  clearStoppedByUser: (projectId: string, threadId: string) => Promise<void>
  /**
   * What a thread is currently waiting on, when it stopped for a person.
   *
   * A follow-up would otherwise race the blocked driver call and leave a card on
   * screen that no turn is waiting for, so the caller is told which decision to
   * answer instead of being allowed to steer past it.
   */
  pendingRequestKind: (threadId: string) => 'question' | 'secret' | 'permission' | null
  /** The last assistant text of a thread, for a status report. */
  latestAssistantText: (projectId: string, threadId: string) => Promise<string | null>
  /** Create a real project thread, in the same path a user-created one takes. */
  createThread: (input: {
    projectId: string
    title: string
    settings: ThreadSettings
    assistantId?: string
    dispatchOrigin?: ThreadDispatchOrigin
  }) => Promise<Thread>
  /** Run a prompt on a thread, exactly as the app does for its own dispatch. */
  sendPrompt: (input: {
    projectId: string
    threadId: string
    settings: ThreadSettings
    text: string
  }) => Promise<void>
  /**
   * Write the dispatch down, so the board that lists a thread's dispatched work
   * still knows about it after the in-memory book is gone.
   *
   * Best-effort by design: a ledger write that fails must never turn an accepted
   * dispatch into an error the agent has to explain, because the thread it
   * started is real and already running.
   */
  /**
   * Hand a decision back to a thread this conversation dispatched.
   *
   * The three answer paths are the app's own resolution APIs, so a decision taken
   * here settles exactly like one taken on the blocked thread's own card: the
   * waiting driver call returns and the turn continues.
   */
  answerQuestion: (input: {
    projectId: string
    threadId: string
    requestId: string
    /** One entry per question, each holding the selected answers for it. */
    answers: string[][]
  }) => Promise<unknown>
  answerSecret: (input: {
    projectId: string
    threadId: string
    requestId: string
    secrets: AgentSecretSubmission[]
  }) => Promise<unknown>
  replyPermission: (input: {
    projectId: string
    requestId: string
    reply: PermissionReply
  }) => Promise<unknown>
  /**
   * Resolve a secret value the answering agent collected into the device vault,
   * so a value never has to travel through a conversation to reach the thread that
   * asked for it. Null when this conversation holds no such value.
   */
  resolveThreadSecret: (threadId: string, environmentVariable: string) => Promise<string | null>
  recordDispatch: (input: {
    initiatorProjectId: string
    initiatorThreadId: string
    childProjectId: string
    childThreadId: string
    title: string
    ovenId: string
    ovenName: string
    harnessId: string
    providerId: string
    modelId: string
    thinkingLevel?: string
  }) => Promise<void>
}

/**
 * The assistants a dispatch may name, supplied by the part of the app that owns
 * them. Kept behind a setter because the orchestration runtime is created before
 * the assistant directory is attached on the same boot.
 */
export interface OrchestrationAssistantDirectory {
  list: () => readonly Assistant[]
  get: (assistantId: string) => Assistant | null
  /** Remember a handoff so its answer is reported into the group chat. */
  rememberDelegation: (delegation: PendingDonDelegation) => void
}

/** The executor plus the dispatch book the turn lifecycle reads. */
export interface OrchestrationRuntime {
  executor: OrchestrationExecutor
  dispatches: OrchestrationDispatches
  setAssistantDirectory: (directory: OrchestrationAssistantDirectory | null) => void
}

export function createOrchestrationRuntime(deps: OrchestrationDeps): OrchestrationRuntime {
  const dispatches = new OrchestrationDispatches()
  const assistants: { current: OrchestrationAssistantDirectory | null } = { current: null }
  return {
    dispatches,
    executor: createOrchestrationExecutor(deps, dispatches, assistants),
    setAssistantDirectory: (directory) => {
      assistants.current = directory
    }
  }
}

export function createOrchestrationExecutor(
  deps: OrchestrationDeps,
  dispatches: OrchestrationDispatches,
  assistants: { current: OrchestrationAssistantDirectory | null }
): OrchestrationExecutor {
  return async (operation, input, context) => {
    switch (operation) {
      case 'targets':
        return readTargets(deps, input, context, assistants.current)
      case 'dispatch':
        return dispatchWork(deps, dispatches, input, context, assistants.current)
      case 'status':
        return readStatus(deps, input, context)
      case 'continue':
        return continueThread(deps, dispatches, input, context)
      case 'answer':
        return answerDelegatedRequest(deps, input, context)
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
  context: OrchestrationToolContext,
  assistants: OrchestrationAssistantDirectory | null
): Promise<unknown> {
  const harnessFilter = optionalString(input, 'harnessId')
  const ovenFilter = optionalString(input, 'ovenId')
  const includeModels = input['includeModels'] !== false

  const [state, catalogs, accounts, profiles, projects] = await Promise.all([
    deps.listOvens(),
    includeModels ? deps.listProviderCatalogs(context.projectId) : Promise.resolve([]),
    deps.listAccounts(),
    deps.listModelProfiles(),
    deps.listProjects()
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
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path
    })),
    // Assistants are a dispatch target of their own: research, ideas and tasks
    // go to one of them, while coding work goes to a project. The agent reads
    // both lists the same way and names exactly one id.
    assistants: (assistants?.list() ?? [])
      .filter((assistant) => !assistant.builtin)
      .map((assistant) => ({
        assistantId: assistant.id,
        name: assistant.name,
        description: assistant.description ?? '',
        ready: assistantCanDelegate(assistant).ok,
        paused: assistant.paused === true,
        scheduled: assistant.scheduled !== false
      })),
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
    harnesses: [
      ...listHarnesses().map((harness) => ({ id: harness.id, name: harness.name })),
      // ACP agents are harnesses too: an agent dispatching work must be able to
      // pick one the user added, not only the ones shipped here.
      ...acpHarnessDescriptors(await acpAgentsList())
    ],
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
        'This computer is not probed for installed harnesses; a remote Oven reports health per harness.',
      projectDefaults:
        "A dispatch's projectId defaults to `project`, this thread's own project. Pass another id from `projects` to start a thread there.",
      startingAThread:
        'cio_orchestrate_dispatch both creates the thread and sends the prompt, so it is the way to start a thread with a first message. Do not hand-build the thread:create plus agent:sendPrompt pair.',
      continuingAThread:
        'cio_orchestrate_continue sends a follow-up to a thread this conversation already dispatched and changes how it runs in place. cio_orchestrate_status with no threadId lists those threads with their ids. Never dispatch a new thread to add to existing work.'
    }
  }
}

/**
 * The provider catalog and model a dispatch names, or null when this snapshot
 * does not carry them.
 */
function findCatalogModel(
  catalogs: readonly ProviderCatalog[],
  harnessId: string,
  providerId: string,
  modelId: string
): { catalog: ProviderCatalog; model: ProviderModel } | null {
  const catalog = catalogs.find(
    (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
  )
  const model = catalog?.models.find((candidate) => candidate.id === modelId)
  return catalog && model ? { catalog, model } : null
}

/** Resolve and start a real run, refusing anything the catalog does not confirm. */
async function dispatchWork(
  deps: OrchestrationDeps,
  dispatches: OrchestrationDispatches,
  input: Record<string, unknown>,
  context: OrchestrationToolContext,
  assistants: OrchestrationAssistantDirectory | null
): Promise<unknown> {
  const title = requiredString(input, 'title')
  const prompt = requiredString(input, 'prompt')
  const assistantId = optionalString(input, 'assistantId')
  const assistant = assistantId ? (assistants?.get(assistantId) ?? null) : null
  if (assistantId && !assistant) {
    throw new Error(`No assistant has the id "${assistantId}". Read cio_orchestrate_targets.`)
  }
  if (assistant) {
    const usable = assistantCanDelegate(assistant)
    if (!usable.ok) throw new Error(usable.reason)
  }

  // An assistant runs in the assistant space; a project dispatch runs where the
  // agent named it, or in the project this conversation already works on.
  const projectId = assistant
    ? ASSISTANT_SPACE_ID
    : (optionalString(input, 'projectId') ?? context.projectId)

  const requestingThread = await deps.getThread(context.projectId, context.threadId)
  const base = requestingThread?.settings
  const namedHarness = optionalString(input, 'harnessId')
  const namedProvider = optionalString(input, 'providerId')
  const namedModel = optionalString(input, 'modelId')
  const namesModel = Boolean(namedHarness || namedProvider || namedModel)

  // A dispatch that names no model runs on the model this conversation is
  // already using. That is the point of delegating from a chat: the answer comes
  // from the same mind the user is talking to, not from a model left over on the
  // assistant's own row.
  let harnessId: string
  let providerId: string
  let modelId: string
  if (namesModel) {
    harnessId = requiredString(input, 'harnessId')
    providerId = requiredString(input, 'providerId')
    modelId = requiredString(input, 'modelId')
  } else if (base) {
    harnessId = base.harnessId
    providerId = base.providerId
    modelId = base.modelId
  } else {
    throw new Error(
      'This conversation has no model to inherit, so the dispatch must name harnessId, providerId and modelId.'
    )
  }

  const ovenId = optionalString(input, 'ovenId') ?? base?.ovenId ?? LOCAL_OVEN_ID
  const ovenPath =
    optionalString(input, 'ovenPath') ?? (ovenId === base?.ovenId ? base?.ovenPath : undefined)
  const accountId = optionalString(input, 'accountId')

  const acpAgents = await acpAgentsList()
  const harness =
    listHarnesses().find((candidate) => candidate.id === harnessId) ??
    acpHarnessDescriptors(acpAgents).find((candidate) => candidate.id === harnessId)
  if (!harness) throw new Error(`Unknown harness "${harnessId}". Read cio_orchestrate_targets.`)

  const [catalogs, accounts, state] = await Promise.all([
    deps.listProviderCatalogs(assistant ? context.projectId : projectId),
    deps.listAccounts(),
    deps.listOvens()
  ])

  let resolved = namesModel ? findCatalogModel(catalogs, harnessId, providerId, modelId) : null
  if (namesModel && !resolved) {
    // The snapshot the model picker holds is the only source dispatch checks, and
    // it is empty until the app has discovered once. Discover here rather than
    // telling the agent to re-read a target list built from the same snapshot.
    resolved = findCatalogModel(
      await deps.refreshProviderCatalogs(assistant ? context.projectId : projectId),
      harnessId,
      providerId,
      modelId
    )
    if (!resolved) {
      throw new Error(
        `The ${harnessId} catalog has no provider "${providerId}" with model "${modelId}", even after discovering the catalogs again. Read cio_orchestrate_targets and copy an id from it exactly.`
      )
    }
  }
  const { catalog, model } = resolved ?? { catalog: null, model: null }

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

  const inheritsSameModel = !namesModel && base?.harnessId === harnessId
  const account =
    inheritsSameModel && !accountId
      ? { id: base?.accountId ?? resolveAccount(accounts, harnessId, accountId).id }
      : resolveAccount(accounts, harnessId, accountId)
  const accountLabel =
    accounts.find((candidate) => candidate.id === account.id)?.label ?? account.id
  const thinkingLevel =
    resolveThinkingLevel(
      input,
      model?.thinkingPresets?.map((preset) => preset.id)
    ) ??
    (inheritsSameModel ? base?.thinkingLevel : undefined) ??
    DEFAULT_THINKING_LEVEL
  const inferenceMode =
    optionalString(input, 'inferenceMode') ?? (inheritsSameModel ? base?.inferenceMode : undefined)
  // A dispatch always runs under a real permission tier: the one the agent
  // named, the one the requesting thread already runs with, or the app default.
  const permissionLevel: PermissionLevel =
    resolvePermissionLevel(input['permissionLevel']) ?? base?.permissionLevel ?? 'auto_review'

  const settings: ThreadSettings = {
    harnessId,
    providerId,
    modelId,
    accountId: account.id,
    thinkingLevel,
    ...(inferenceMode ? { inferenceMode: inferenceMode as ThreadSettings['inferenceMode'] } : {}),
    ...(inheritsSameModel && base?.contextWindow !== undefined
      ? { contextWindow: base.contextWindow }
      : {}),
    permissionLevel,
    ovenId,
    ...(ovenPath ? { ovenPath } : {})
  }

  const author = assistant ? delegationAuthor(assistant) : null
  const thread = await deps.createThread({
    ...(assistant ? { assistantId: assistant.id } : {}),
    projectId,
    title,
    settings,
    // The board states a dispatched row's origin from the row itself, so the
    // fact is written once, here, with the thread it describes.
    dispatchOrigin: {
      ...(author
        ? { author, assistantId: assistant?.id, assistantName: assistant?.name }
        : requestingThread?.projectId === ASSISTANT_SPACE_ID && requestingThread.assistantId
          ? { assistantId: requestingThread.assistantId }
          : {}),
      initiatorProjectId: context.projectId,
      initiatorThreadId: context.threadId,
      at: Date.now()
    }
  })

  if (assistant && author) {
    // The assistant answers for itself in the group chat: the report is posted
    // under its own name when the run settles, never steered back as a prompt.
    assistants?.rememberDelegation({
      runThreadId: thread.id,
      donProjectId: context.projectId,
      donThreadId: context.threadId,
      author,
      assistantName: assistant.name,
      request: prompt,
      createdAt: Date.now()
    })
  } else {
    dispatches.remember({
      runThreadId: thread.id,
      requestingProjectId: context.projectId,
      requestingThreadId: context.threadId,
      title,
      ovenName: oven.name,
      settings,
      createdAt: Date.now()
    })
  }

  // Write the dispatch down before the run is sent. The board that lists this
  // thread's dispatched work reads the ledger, and the in-memory book above is
  // only alive for as long as this process is: after a restart the thread rows
  // are all that would be left, with nothing tying them to the thread that
  // started them. A failed write never blocks the run.
  try {
    await deps.recordDispatch({
      initiatorProjectId: context.projectId,
      initiatorThreadId: context.threadId,
      childProjectId: projectId,
      childThreadId: thread.id,
      title,
      ovenId: oven.id,
      ovenName: oven.name,
      harnessId,
      providerId,
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {})
    })
  } catch (error) {
    Logger.dev('Orchestration dispatch was not recorded:', error)
  }

  await deps.sendPrompt({ projectId, threadId: thread.id, settings, text: prompt })

  return {
    status: 'dispatched',
    kind: assistant ? 'assistant' : 'project',
    ...(assistant ? { assistant: { id: assistant.id, name: assistant.name } } : {}),
    threadId: thread.id,
    projectId,
    title: thread.title,
    oven: { id: oven.id, name: oven.name, kind: oven.kind },
    harness: { id: harness.id, name: harness.name },
    model: {
      providerId: catalog?.id ?? providerId,
      providerName: catalog?.name ?? providerId,
      modelId: model?.id ?? modelId,
      name: model?.name ?? modelId
    },
    thinkingLevel,
    account: { id: account.id, label: accountLabel },
    note: assistant
      ? 'The assistant runs on its own thread and its reply appears in this conversation under its own name. Do not wait for it.'
      : 'The run has been accepted, not finished. The app reports its outcome into this conversation when the thread settles.'
  }
}

/**
 * Hand a decision back to a thread this conversation dispatched.
 *
 * The dispatcher only ever holds ids and a human's answer: a secret arrives as the
 * name the value was collected under, so the app resolves it from the vault and the
 * value never reaches either model's context. Every path is the app's own
 * resolution API, so the blocked thread settles exactly as it would from its own
 * card and its turn simply continues.
 */
async function answerDelegatedRequest(
  deps: OrchestrationDeps,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const kind = optionalString(input, 'kind')
  if (kind !== 'question' && kind !== 'secret' && kind !== 'permission') {
    throw new Error('kind must be "question", "secret" or "permission".')
  }
  const requestId = requiredString(input, 'requestId')
  const threadId = requiredString(input, 'threadId')
  const projectId = requiredString(input, 'projectId')
  // The decision is given to a real thread, so the ids have to name one that
  // exists before anything is resolved against them.
  const thread = await deps.getThread(projectId, threadId)
  if (!thread) throw new Error(`No thread "${threadId}" in project "${projectId}".`)

  if (kind === 'question') {
    // One entry per question, each entry the selected answers for that question.
    // A flat string is accepted as a one-choice answer, because a model that read
    // a single-choice card naturally reports it that way.
    const rawAnswers = Array.isArray(input['answers']) ? input['answers'] : []
    const answers = rawAnswers
      .map((entry) =>
        Array.isArray(entry)
          ? entry.filter((value): value is string => typeof value === 'string')
          : typeof entry === 'string'
            ? [entry]
            : []
      )
      .filter((entry) => entry.length > 0)
    if (answers.length === 0) {
      throw new Error('An answer needs `answers`, one entry per question, as the user gave them.')
    }
    await deps.answerQuestion({ projectId, threadId, requestId, answers })
    return {
      status: 'answered',
      kind,
      threadId,
      projectId,
      requestId,
      note: 'The thread accepted the answer and continues on its own. Its outcome is reported here when it settles.'
    }
  }

  if (kind === 'permission') {
    const reply = optionalString(input, 'permission')
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      throw new Error('A permission answer needs `permission`: "once", "always" or "reject".')
    }
    await deps.replyPermission({ projectId, requestId, reply })
    return {
      status: 'answered',
      kind,
      threadId,
      projectId,
      requestId,
      permission: reply,
      note: 'The thread accepted the decision and continues on its own.'
    }
  }

  const requested = Array.isArray(input['secrets']) ? input['secrets'] : []
  if (requested.length === 0) {
    throw new Error(
      'A secret answer needs `secrets`: one entry per requested secret, carrying its secretId and the environmentVariable it was collected under.'
    )
  }
  const submissions: AgentSecretSubmission[] = []
  const unresolved: string[] = []
  for (const entry of requested) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const secretId = optionalString(record, 'secretId')
    const environmentVariable = optionalString(record, 'environmentVariable')
    if (!secretId || !environmentVariable) continue
    // The value comes from this conversation's own vault entries, keyed by the
    // variable the agent collected it under. Nothing here can read a value the
    // user did not supply for this app.
    const value = await deps.resolveThreadSecret(context.threadId, environmentVariable)
    if (!value) {
      unresolved.push(environmentVariable)
      continue
    }
    submissions.push({ secretId, value })
  }
  if (submissions.length === 0) {
    throw new Error(
      `No value is stored under ${unresolved.join(', ') || 'that name'} in this conversation. Collect it with cio_ask_secret first, then answer with the variable it was stored under.`
    )
  }
  await deps.answerSecret({ projectId, threadId, requestId, secrets: submissions })
  return {
    status: 'answered',
    kind,
    threadId,
    projectId,
    requestId,
    delivered: submissions.map((entry) => entry.secretId),
    ...(unresolved.length > 0 ? { unresolved } : {}),
    note: 'The thread received the values directly from the vault and continues on its own. The values were never shown to either conversation.'
  }
}

/**
 * Keep an existing thread going instead of starting a new one.
 *
 * A dispatch is the first message of a conversation, not the whole of it. The
 * user's next instruction belongs in the thread that already holds the work, and
 * so does a change of mind about how it runs: the thread keeps its history and
 * its id, the model fields are validated against the same catalogs a dispatch
 * uses, and the change is written to the thread row so it survives the turn.
 *
 * Two facts shape the answer. A follow-up into a running turn steers that turn,
 * which still runs on the model that started it, so a model change made at the
 * same time is recorded and applies from the next turn. A prompt-less call only
 * changes how the thread runs, which is what "switch this thread to model X"
 * means when the user is not also asking for more work.
 */
async function continueThread(
  deps: OrchestrationDeps,
  dispatches: OrchestrationDispatches,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const threadId = requiredString(input, 'threadId')
  const prompt = optionalString(input, 'prompt')
  const namedHarness = optionalString(input, 'harnessId')
  const namedProvider = optionalString(input, 'providerId')
  const namedModel = optionalString(input, 'modelId')
  const namesModel = Boolean(namedHarness || namedProvider || namedModel)
  const namedThinking = optionalString(input, 'thinkingLevel')
  const namedInference = optionalString(input, 'inferenceMode')
  const namedPermission = stringValue(input['permissionLevel'])
  const namedAccount = optionalString(input, 'accountId')
  const namedOven = optionalString(input, 'ovenId')
  const namedOvenPath = optionalString(input, 'ovenPath')

  if (!prompt && !namesModel && !namedThinking && !namedPermission && !namedAccount && !namedOven) {
    throw new Error(
      'Nothing to change: send a `prompt` with the follow-up instruction, or name the setting to change (harnessId with providerId and modelId, thinkingLevel, permissionLevel, accountId, ovenId).'
    )
  }
  if (namesModel && !(namedHarness && namedProvider && namedModel)) {
    throw new Error(
      'Changing the model needs the exact harnessId, providerId and modelId together. Read cio_orchestrate_targets and copy them exactly.'
    )
  }

  const thread = await resolveThread(deps, threadId, optionalString(input, 'projectId'))
  const pending = deps.pendingRequestKind(thread.id)
  if (prompt && pending) {
    throw new Error(
      `This thread is waiting on a ${pending}. Answer it with cio_orchestrate_answer, or from its card in this conversation, and it continues on its own. A follow-up now would race the decision it is waiting for.`
    )
  }
  const base = thread.settings
  if (!base) {
    throw new Error(
      'This thread has no run settings yet, so there is nothing to change. Send it a prompt first.'
    )
  }

  const harnessId = namedHarness ?? base.harnessId
  const providerId = namedProvider ?? base.providerId
  const modelId = namedModel ?? base.modelId
  const modelChanged =
    harnessId !== base.harnessId || providerId !== base.providerId || modelId !== base.modelId
  const sameHarness = harnessId === base.harnessId

  const harness =
    listHarnesses().find((candidate) => candidate.id === harnessId) ??
    acpHarnessDescriptors(await acpAgentsList()).find((candidate) => candidate.id === harnessId)
  if (!harness) throw new Error(`Unknown harness "${harnessId}". Read cio_orchestrate_targets.`)

  // The catalogs belong to the project the work lives in, which for an assistant
  // thread is the conversation asking, exactly as a dispatch resolves them.
  const catalogProjectId =
    thread.projectId === ASSISTANT_SPACE_ID ? context.projectId : thread.projectId
  let resolvedModel: ProviderModel | null = null
  if (modelChanged) {
    let found = findCatalogModel(
      await deps.listProviderCatalogs(catalogProjectId),
      harnessId,
      providerId,
      modelId
    )
    if (!found) {
      found = findCatalogModel(
        await deps.refreshProviderCatalogs(catalogProjectId),
        harnessId,
        providerId,
        modelId
      )
    }
    if (!found) {
      throw new Error(
        `The ${harnessId} catalog has no provider "${providerId}" with model "${modelId}". Read cio_orchestrate_targets and copy a model id from it exactly.`
      )
    }
    resolvedModel = found.model
  }

  // A named thinking level is checked against the model that will run it, so a
  // level the model does not offer is refused rather than stored and ignored.
  const currentModel =
    modelChanged || namedThinking
      ? (resolvedModel ??
        findCatalogModel(
          await deps.listProviderCatalogs(catalogProjectId),
          harnessId,
          providerId,
          modelId
        )?.model ??
        null)
      : null
  const offeredPresets = currentModel?.thinkingPresets
  const offered = offeredPresets?.map((preset) => preset.id)
  let thinkingLevel: ThinkingLevel = base.thinkingLevel
  if (namedThinking) {
    const chosen = resolveThinkingLevel(input, offered)
    if (!chosen) throw new Error(`Unknown thinking level "${namedThinking}".`)
    thinkingLevel = chosen
  } else if (modelChanged) {
    // Keep the thread's effort when the new model offers it, otherwise take the
    // lowest one it does offer, which is the same choice a fresh dispatch makes.
    thinkingLevel =
      resolveDefaultThinkingLevel(offeredPresets, undefined, base.thinkingLevel) ??
      base.thinkingLevel
  }

  const inferenceMode = namedInference ? resolveInferenceMode(namedInference) : base.inferenceMode
  const permissionLevel: PermissionLevel =
    resolvePermissionLevel(namedPermission) ?? base.permissionLevel

  const accounts = await deps.listAccounts()
  const accountId = namedAccount
    ? resolveAccount(accounts, harnessId, namedAccount).id
    : sameHarness && base.accountId
      ? base.accountId
      : resolveAccount(accounts, harnessId, undefined).id
  const accountLabel = accounts.find((candidate) => candidate.id === accountId)?.label ?? accountId

  const ovenId = namedOven ?? base.ovenId ?? LOCAL_OVEN_ID
  const state = await deps.listOvens()
  const oven = state.ovens.find((candidate) => candidate.id === ovenId)
  if (!oven) throw new Error(`Unknown Oven "${ovenId}". Read cio_orchestrate_targets.`)
  const ovenPath =
    namedOvenPath ?? (ovenId === (base.ovenId ?? LOCAL_OVEN_ID) ? base.ovenPath : undefined)

  const settings: ThreadSettings = {
    ...base,
    harnessId,
    providerId,
    modelId,
    accountId,
    thinkingLevel,
    permissionLevel,
    ovenId,
    ...(inferenceMode ? { inferenceMode } : {}),
    ...(ovenPath ? { ovenPath } : {})
  }
  // A context window is a property of the model that produced it, so a model
  // change drops it rather than carrying an old budget onto a new model.
  if (modelChanged) delete settings.contextWindow
  // The user asked for this from their own conversation, so a thread they had
  // stopped resumes: the latch only ever means "until the user comes back".
  delete settings.stoppedByUserAt
  await deps.clearStoppedByUser(thread.projectId, thread.id)
  await deps.updateThreadSettings(thread.projectId, thread.id, settings)

  if (prompt) {
    await deps.sendPrompt({
      projectId: thread.projectId,
      threadId: thread.id,
      settings,
      text: prompt
    })
    // The follow-up reports back where the dispatch did, so an answer to more
    // work lands in the conversation that asked for it. An assistant thread is
    // already covered by the group-chat delegation path.
    const reportedAsDelegation =
      thread.projectId === ASSISTANT_SPACE_ID &&
      thread.dispatchOrigin?.initiatorProjectId === ASSISTANT_SPACE_ID
    if (!reportedAsDelegation) {
      dispatches.remember({
        runThreadId: thread.id,
        requestingProjectId: context.projectId,
        requestingThreadId: context.threadId,
        title: thread.title,
        ovenName: oven.name,
        settings,
        createdAt: Date.now()
      })
    }
  }

  // Keep the ledger row in step with the thread it names, so the board that
  // lists this conversation's dispatched work shows the model it now runs on.
  try {
    await deps.recordDispatch({
      initiatorProjectId: context.projectId,
      initiatorThreadId: context.threadId,
      childProjectId: thread.projectId,
      childThreadId: thread.id,
      title: thread.title,
      ovenId: oven.id,
      ovenName: oven.name,
      harnessId,
      providerId,
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {})
    })
  } catch (error) {
    Logger.dev('Orchestration continuation was not recorded:', error)
  }

  const running = isThreadBusyStatus(thread.status)
  return {
    status: prompt ? 'continued' : 'updated',
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    running,
    model: {
      harnessId: harness.id,
      harnessName: harness.name,
      providerId,
      modelId,
      thinkingLevel,
      name: resolvedModel?.name ?? modelId
    },
    account: { id: accountId, label: accountLabel },
    permissionLevel,
    oven: { id: oven.id, name: oven.name },
    note: prompt
      ? running
        ? 'The follow-up reached the thread while it is running. Any model or permission change here is recorded and applies from its next turn, because the live turn keeps the model it started on.'
        : 'The thread accepted the follow-up and continues with its own history. Its outcome is reported here when it settles.'
      : running
        ? "The change is recorded and applies from the thread's next turn; its live turn keeps the model it started on."
        : 'The change is recorded and applies the next time this thread runs.'
  }
}

/** One dispatched thread's current state, and its latest result when settled. */
async function readStatus(
  deps: OrchestrationDeps,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
): Promise<unknown> {
  const threadId = optionalString(input, 'threadId')
  // Without an id the call answers the question every follow-up starts with: what
  // have I dispatched, and what is each one's id and current model? Reading it
  // from the ledger means an app restart never loses the threads a conversation
  // started, and the list is the only acceptable source of a threadId.
  if (!threadId) {
    const threads = await deps.listDispatchedThreads(context.projectId, context.threadId)
    return {
      count: threads.length,
      threads: threads.map((thread) => ({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        status: thread.status,
        running: isThreadBusyStatus(thread.status),
        assistantId: thread.assistantId,
        settings: settingsSummary(thread)
      })),
      note: 'Pass one of these threadIds to cio_orchestrate_continue to send a follow-up or change its model, thinking level, harness or permission level. Never dispatch a new thread to add to work already listed here.'
    }
  }
  const thread = await resolveThread(deps, threadId, optionalString(input, 'projectId'))

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
          thinkingLevel: thread.settings.thinkingLevel,
          inferenceMode: thread.settings.inferenceMode ?? 'normal',
          accountId: thread.settings.accountId,
          permissionLevel: thread.settings.permissionLevel
        }
      : null,
    ...(busy ? {} : { result: await deps.latestAssistantText(thread.projectId, thread.id) })
  }
}

/** One thread's run settings, as a status result states them. */
function settingsSummary(thread: Thread): Record<string, unknown> | null {
  if (!thread.settings) return null
  return {
    harnessId: thread.settings.harnessId,
    providerId: thread.settings.providerId,
    modelId: thread.settings.modelId,
    thinkingLevel: thread.settings.thinkingLevel,
    inferenceMode: thread.settings.inferenceMode ?? 'normal',
    permissionLevel: thread.settings.permissionLevel,
    ovenId: thread.settings.ovenId ?? LOCAL_OVEN_ID
  }
}

/** The thread a follow-up names, verified against the project when one was given. */
async function resolveThread(
  deps: OrchestrationDeps,
  threadId: string,
  projectId: string | undefined
): Promise<Thread> {
  const thread = await deps.getThreadById(threadId)
  if (!thread) {
    throw new Error(
      `No thread "${threadId}". Read cio_orchestrate_status with no threadId to list the threads this conversation dispatched.`
    )
  }
  if (projectId && thread.projectId !== projectId) {
    throw new Error(`Thread "${threadId}" is not in project "${projectId}".`)
  }
  return thread
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

/** The named inference tier, validating the value the tool accepted. */
function resolveInferenceMode(value: string): ThreadSettings['inferenceMode'] {
  if (
    !MODEL_PROFILE_INFERENCE_MODES.includes(value as NonNullable<ThreadSettings['inferenceMode']>)
  ) {
    throw new Error(
      `Unknown inference mode "${value}". Use one of: ${MODEL_PROFILE_INFERENCE_MODES.join(', ')}.`
    )
  }
  return value as NonNullable<ThreadSettings['inferenceMode']>
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

/** The user's ACP agents, loaded so a dispatch target list is complete. */
async function acpAgentsList(): Promise<ReturnType<typeof currentAcpAgents>> {
  await ensureAcpAgentsLoaded()
  return currentAcpAgents()
}
