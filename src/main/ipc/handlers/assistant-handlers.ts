import { validateModelRuntimeSettings } from '../../../lib/model-runtime-settings'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateEntityId } from '../ipc-validation'
import { requireString } from './shared'
import { assistantNextStepsPrompt } from '../../../lib/assistant-next-steps'
import {
  ASSISTANT_CHAT_SETUP_ACTION,
  ASSISTANT_CHAT_SETUP_PROMPT,
  ASSISTANT_MANUAL_SETUP_ACTION,
  assistantManualSetupPrompt
} from '../../../lib/assistant-chat-setup'
import { assistantPrimaryModel, settingsWithAssistantModel } from '../../../lib/assistant-agents'
import { LOCAL_OVEN_ID } from '../../../lib/ovens'
import {
  ASSISTANT_DELIVERY_CHANNEL_IDS,
  ASSISTANT_IMPACT_IDS,
  ASSISTANT_TIMELINESS_IDS
} from '../../../lib/assistant-reporting'
import { assistantFirstKnowledgeSave, assistantIsScheduled } from '../../../lib/types'
import {
  broadcastAutoAnswersChanged,
  broadcastBackgroundRunsChanged,
  broadcastMissedRunsChanged,
  broadcastAssistantsChanged
} from '../../scheduler/assistant-events'
import { broadcastThreadUpdate } from '../../chat/thread-events'
import { raiseStartAtLoginOffer } from '../../system/start-at-login-offer'
import type { IpcHandlerContext } from './context'
import type {
  CreateAssistantInput,
  AssistantAgents,
  AssistantConnection,
  AssistantDelivery,
  AssistantDeliveryChannel,
  AssistantExecution,
  AssistantImpact,
  AssistantPriority,
  AssistantSchedule,
  AssistantTimeliness,
  UpdateAssistantInput
} from '../../../lib/types'
import {
  ASSISTANT_NAME_LIMIT,
  ASSISTANT_PERSONALITY_LIMIT,
  ASSISTANT_SCHEDULE_NAME_LIMIT
} from '../../../lib/types'
import { sanitizeCustomSvg } from '../../../lib/custom-svg'
import { validateCustomIconImage } from '../../../lib/custom-icon'

const CADENCES = new Set(['once', 'hourly', 'daily', 'weekdays', 'weekly'])
const DELIVERY_CHANNELS = new Set<string>(ASSISTANT_DELIVERY_CHANNEL_IDS)
const TIMELINESS_BRACKETS = new Set<string>(ASSISTANT_TIMELINESS_IDS)
const IMPACT_BRACKETS = new Set<string>(ASSISTANT_IMPACT_IDS)
const MAX_ASSISTANT_NAME = ASSISTANT_NAME_LIMIT
const MAX_ASSISTANT_DESCRIPTION = 2000
const MAX_ASSISTANT_PERSONALITY = ASSISTANT_PERSONALITY_LIMIT
const MAX_ASSISTANT_SCHEDULE_NAME = ASSISTANT_SCHEDULE_NAME_LIMIT
const MAX_KNOWLEDGE = 100_000
const MAX_CONNECTIONS = 64
const MAX_CONNECTION_SETUP = 4_000
const MAX_TIMES = 24
const MAX_FALLBACKS = 12
const MAX_DELIVERY_TARGET = 300
const MAX_DELIVERY_NOTE = 1_000

/** Parse one `HH:mm` value, returning null when malformed. */
function parseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Validate an untrusted schedule value into an AssistantSchedule, or null to clear. */
function sanitizeSchedule(value: unknown): AssistantSchedule | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Schedule must be an object or null')
  const record = value as Record<string, unknown>
  const cadence = typeof record.cadence === 'string' ? record.cadence : ''
  if (!CADENCES.has(cadence)) throw new TypeError('Schedule cadence is invalid')
  const times: string[] = []
  if (Array.isArray(record.times)) {
    for (const entry of record.times.slice(0, MAX_TIMES)) {
      const parsed = parseTime(entry)
      if (parsed && !times.includes(parsed)) times.push(parsed)
    }
  }
  const weekdays = Array.isArray(record.weekdays)
    ? record.weekdays.filter(
        (day): day is number => typeof day === 'number' && day >= 0 && day <= 6
      )
    : undefined
  const onceAt =
    typeof record.onceAt === 'number' && Number.isFinite(record.onceAt) ? record.onceAt : undefined
  return {
    cadence: cadence as AssistantSchedule['cadence'],
    times: times.sort(),
    ...(weekdays ? { weekdays } : {}),
    ...(onceAt !== undefined ? { onceAt } : {})
  }
}

function sanitizeConnections(value: unknown): AssistantConnection[] {
  if (!Array.isArray(value)) return []
  const result: AssistantConnection[] = []
  for (const entry of value.slice(0, MAX_CONNECTIONS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.utilityId !== 'string' || typeof record.label !== 'string') continue
    result.push({
      utilityId: record.utilityId.slice(0, 200),
      label: record.label.slice(0, 200),
      ...(typeof record.kind === 'string' ? { kind: record.kind.slice(0, 64) } : {}),
      ...(record.required === true ? { required: true } : {}),
      ...(typeof record.setup === 'string'
        ? { setup: record.setup.slice(0, MAX_CONNECTION_SETUP) }
        : {})
    })
  }
  return result
}

/** One model selection: harness, provider, and model are required. */
function sanitizeModelSelection(value: unknown): AssistantAgents['fallbacks'][number] | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.harnessId !== 'string' ||
    typeof record.providerId !== 'string' ||
    typeof record.modelId !== 'string'
  ) {
    return null
  }
  return {
    ...validateModelRuntimeSettings(record),
    harnessId: record.harnessId.slice(0, 64),
    providerId: record.providerId.slice(0, 128),
    modelId: record.modelId.slice(0, 200),
    ...(typeof record.accountId === 'string' ? { accountId: record.accountId.slice(0, 200) } : {}),
    ...(typeof record.thinkingLevel === 'string'
      ? {
          thinkingLevel: record.thinkingLevel.slice(
            0,
            16
          ) as AssistantAgents['fallbacks'][number]['thinkingLevel']
        }
      : {})
  }
}

/** Validate an untrusted model set, or null to clear it. */
function sanitizeAgents(value: unknown): AssistantAgents | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Assistant agents must be an object or null')
  const record = value as Record<string, unknown>
  const primary = record.primary === undefined ? null : sanitizeModelSelection(record.primary)
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
        .slice(0, MAX_FALLBACKS)
        .map(sanitizeModelSelection)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : []
  return { ...(primary ? { primary } : {}), fallbacks }
}

/**
 * Validate an untrusted delivery value into an AssistantDelivery, or null to clear
 * it. The channel must be one the app knows, so an assistant is never handed a
 * delivery nothing can honour. A target is capped, and dropped for the in-app
 * channel, which has no destination to name.
 */
function sanitizeDelivery(value: unknown): AssistantDelivery | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Assistant delivery must be an object or null')
  const record = value as Record<string, unknown>
  const channel = typeof record.channel === 'string' ? record.channel.trim() : ''
  if (!DELIVERY_CHANNELS.has(channel)) {
    throw new TypeError('Assistant delivery channel is invalid')
  }
  const typed = channel as AssistantDeliveryChannel
  const target =
    typeof record.target === 'string' ? record.target.trim().slice(0, MAX_DELIVERY_TARGET) : ''
  const note = typeof record.note === 'string' ? record.note.trim().slice(0, MAX_DELIVERY_NOTE) : ''
  return {
    channel: typed,
    ...(target && typed !== 'in-app' ? { target } : {}),
    ...(note ? { note } : {})
  }
}

/**
 * Validate an untrusted priority value into an AssistantPriority, or null to clear
 * it. Both brackets must resolve, so an assistant never carries half an urgency.
 */
function sanitizePriority(value: unknown): AssistantPriority | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Assistant priority must be an object or null')
  const record = value as Record<string, unknown>
  const timeliness = typeof record.timeliness === 'string' ? record.timeliness.trim() : ''
  const impact = typeof record.impact === 'string' ? record.impact.trim() : ''
  if (!TIMELINESS_BRACKETS.has(timeliness)) {
    throw new TypeError('Assistant timeliness bracket is invalid')
  }
  if (!IMPACT_BRACKETS.has(impact)) {
    throw new TypeError('Assistant impact bracket is invalid')
  }
  return {
    timeliness: timeliness as AssistantTimeliness,
    impact: impact as AssistantImpact
  }
}

/**
 * Validate an untrusted execution target into an AssistantExecution, or null to
 * clear it (run on this computer). A target must name an Oven; the path stays
 * optional so the Oven's default checkout can be used.
 */
function sanitizeExecution(value: unknown): AssistantExecution | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object')
    throw new TypeError('Assistant execution must be an object or null')
  const record = value as Record<string, unknown>
  const ovenId = typeof record.ovenId === 'string' ? record.ovenId.trim() : ''
  if (!ovenId) throw new TypeError('Assistant execution must name an Oven')
  const ovenPath = typeof record.ovenPath === 'string' ? record.ovenPath.trim() : ''
  if (ovenId === LOCAL_OVEN_ID) return null
  return { ovenId: ovenId.slice(0, 200), ...(ovenPath ? { ovenPath } : {}) }
}

function validateCreateInput(value: unknown): CreateAssistantInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid assistant input')
  const record = value as Record<string, unknown>
  return {
    name: requireString(record.name, 'Assistant name').slice(0, MAX_ASSISTANT_NAME),
    ...(typeof record.description === 'string'
      ? { description: record.description.slice(0, MAX_ASSISTANT_DESCRIPTION) }
      : {}),
    ...(typeof record.personality === 'string'
      ? { personality: record.personality.slice(0, MAX_ASSISTANT_PERSONALITY) }
      : {}),
    ...(typeof record.scheduled === 'boolean' ? { scheduled: record.scheduled } : {}),
    ...(typeof record.scheduleName === 'string'
      ? { scheduleName: record.scheduleName.slice(0, MAX_ASSISTANT_SCHEDULE_NAME) }
      : {}),
    ...(typeof record.color === 'string' ? { color: record.color.slice(0, 32) } : {}),
    ...(typeof record.iconType === 'string' ? { iconType: record.iconType.slice(0, 64) } : {}),
    schedule: sanitizeSchedule(record.schedule),
    ...(typeof record.knowledge === 'string'
      ? { knowledge: record.knowledge.slice(0, MAX_KNOWLEDGE) }
      : {}),
    ...(record.connections !== undefined
      ? { connections: sanitizeConnections(record.connections) }
      : {}),
    ...(record.agents !== undefined ? { agents: sanitizeAgents(record.agents) ?? undefined } : {}),
    ...(record.execution !== undefined
      ? { execution: sanitizeExecution(record.execution) ?? undefined }
      : {}),
    ...(record.delivery !== undefined
      ? { delivery: sanitizeDelivery(record.delivery) ?? undefined }
      : {}),
    ...(record.priority !== undefined
      ? { priority: sanitizePriority(record.priority) ?? undefined }
      : {}),
    ...(typeof record.paused === 'boolean' ? { paused: record.paused } : {})
  }
}

function validateUpdateInput(value: unknown): UpdateAssistantInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid assistant patch')
  const record = value as Record<string, unknown>
  const patch: UpdateAssistantInput = {}
  if (record.name !== undefined) {
    patch.name = requireString(record.name, 'Assistant name').slice(0, MAX_ASSISTANT_NAME)
  }
  if (record.description !== undefined) {
    patch.description =
      record.description === null
        ? null
        : requireString(record.description, 'Assistant description', true).slice(
            0,
            MAX_ASSISTANT_DESCRIPTION
          )
  }
  if (record.scheduled !== undefined) {
    if (typeof record.scheduled !== 'boolean') {
      throw new TypeError('Assistant scheduled flag must be a boolean')
    }
    patch.scheduled = record.scheduled
  }
  if (record.personality !== undefined) {
    patch.personality =
      record.personality === null
        ? null
        : requireString(record.personality, 'Assistant personality', true).slice(
            0,
            MAX_ASSISTANT_PERSONALITY
          )
  }
  if (record.scheduleName !== undefined) {
    patch.scheduleName =
      record.scheduleName === null
        ? null
        : requireString(record.scheduleName, 'Schedule name', true).slice(
            0,
            MAX_ASSISTANT_SCHEDULE_NAME
          )
  }
  if (record.color !== undefined) {
    patch.color =
      record.color === null ? null : requireString(record.color, 'Assistant colour').slice(0, 32)
  }
  if (record.icon !== undefined) {
    patch.icon =
      record.icon === null ? null : requireString(record.icon, 'Assistant icon').slice(0, 200)
  }
  if (record.iconType !== undefined) {
    patch.iconType =
      record.iconType === null
        ? null
        : requireString(record.iconType, 'Assistant icon type').slice(0, 64)
  }
  if (record.customSvg !== undefined) {
    patch.customSvg =
      record.customSvg === null
        ? null
        : sanitizeCustomSvg(requireString(record.customSvg, 'Assistant custom SVG'))
  }
  if (record.schedule !== undefined) patch.schedule = sanitizeSchedule(record.schedule)
  if (record.knowledge !== undefined) {
    if (typeof record.knowledge !== 'string')
      throw new TypeError('Assistant knowledge must be a string')
    patch.knowledge = record.knowledge.slice(0, MAX_KNOWLEDGE)
  }
  if (record.connections !== undefined) patch.connections = sanitizeConnections(record.connections)
  if (record.agents !== undefined) {
    const agents = sanitizeAgents(record.agents)
    if (agents) patch.agents = agents
  }
  if (record.delivery !== undefined) patch.delivery = sanitizeDelivery(record.delivery)
  if (record.priority !== undefined) patch.priority = sanitizePriority(record.priority)
  if (record.execution !== undefined) patch.execution = sanitizeExecution(record.execution)
  if (typeof record.paused === 'boolean') patch.paused = record.paused
  return patch
}

/**
 * Assistant View IPC   assistant CRUD, task grouping, and missed-run actions.
 *
 * Task creation/listing/forking live on the existing thread channels; these
 * cover only the assistant layer and the scheduler's missed-run surface.
 */
export function registerAssistantHandlers(ctx: IpcHandlerContext): void {
  const { projectManager, assistantManager, assistantScheduler } = ctx

  const requireScheduler = () => {
    if (!assistantScheduler) throw new Error('The assistant scheduler is not available')
    return assistantScheduler
  }

  const broadcastAssistants = () => broadcastAssistantsChanged(assistantManager.listAssistants())

  /**
   * An assistant or task write landed: push the list and let the scheduler
   * re-decide its tick.
   *
   * The scheduler only runs its tick while a task can come due, so the write
   * that takes the last task off the clock (or puts the first one on) is the
   * moment to recompute that. It re-reads the schedule itself instead of being
   * told what changed. Optional, because the scheduler is not up during early
   * hydration and a failed write must not fail with it.
   */
  const assistantsChanged = () => {
    broadcastAssistants()
    assistantScheduler?.refreshSchedule()
  }

  // Registered on the hydration surface when the bootstrap already owns it, so
  // Assistant View's first hydration pass never awaits the post-paint graph just
  // to guarantee the hidden assistant container exists.
  if (!ctx.options.hydrationHandlersRegistered) {
    ipcMain.handle('assistant:ensureSpace', () => projectManager.ensureAssistantSpace())
  }
  ipcMain.handle('assistant:list', () => assistantManager.listAssistants())

  ipcMain.handle('assistant:create', (_, input: unknown) => {
    const assistant = assistantManager.createAssistant(validateCreateInput(input))
    assistantsChanged()
    return assistant
  })

  ipcMain.handle('assistant:update', async (_, assistantId: unknown, input: unknown) => {
    const safeId = validateEntityId(assistantId, 'Assistant ID')
    const existing = assistantManager.getAssistant(safeId)
    const assistant = assistantManager.updateAssistant(safeId, validateUpdateInput(input))
    assistantsChanged()
    // The first knowledge an assistant ever gets is the moment its owner has work they
    // expect to run, so it is the one moment the app offers to start at login.
    // It is raised once in an install's life: the offer carries its own flag.
    if (existing && assistantFirstKnowledgeSave(existing, assistant)) {
      await raiseStartAtLoginOffer(ctx.storage)
    }
    return assistant
  })

  ipcMain.handle('assistant:delete', async (_, assistantId: unknown) => {
    // The assistant's threads   its hidden knowledge thread and each task's runs
    // included   are deleted with it, through the same canonical path as
    // `thread:delete`, and its artifact folder goes with them. The scheduler
    // then forgets the assistant so no pending missed run keeps badging for a task
    // that no longer exists.
    const safeId = validateEntityId(assistantId, 'Assistant ID')
    const result = await assistantManager.deleteAssistant(safeId)
    assistantScheduler?.forgetAssistant(safeId, result.removedThreadIds)
    assistantsChanged()
    return result
  })

  ipcMain.handle('assistant:reorder', (_, orderedIds: unknown) => {
    if (!Array.isArray(orderedIds)) throw new TypeError('Assistant order must be an array')
    const ids = orderedIds.map((id) => validateEntityId(id, 'Assistant ID'))
    const assistants = assistantManager.reorderAssistants(ids)
    assistantsChanged()
    return assistants
  })

  ipcMain.handle('assistant:setPinned', (_, assistantId: unknown, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new TypeError('Assistant pin state must be a boolean')
    const assistant = assistantManager.setPinned(
      validateEntityId(assistantId, 'Assistant ID'),
      pinned
    )
    assistantsChanged()
    return assistant
  })

  ipcMain.handle('assistant:setIcon', async (_, assistantId: unknown, rawImage: unknown) => {
    const assistant = await assistantManager.setIcon(
      validateEntityId(assistantId, 'Assistant ID'),
      validateCustomIconImage(rawImage)
    )
    assistantsChanged()
    return assistant
  })

  ipcMain.handle('assistant:clearIcon', async (_, assistantId: unknown) => {
    const assistant = await assistantManager.clearIcon(
      validateEntityId(assistantId, 'Assistant ID')
    )
    assistantsChanged()
    return assistant
  })

  ipcMain.handle('assistant:getIcon', (_, assistantId: unknown) =>
    assistantManager.getIconDataUrl(validateEntityId(assistantId, 'Assistant ID'))
  )

  ipcMain.handle('assistant:assignTask', (_, threadId: unknown, assistantId: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const safeAssistantId =
      assistantId === null ? null : validateEntityId(assistantId, 'Assistant ID')
    const thread = assistantManager.assignTask(safeThreadId, safeAssistantId)
    // The task now belongs to another assistant's clock, so the tick is recomputed.
    assistantScheduler?.refreshSchedule()
    return thread
  })

  ipcMain.handle('assistant:knowledgeThread', (_, assistantId: unknown) =>
    assistantManager.knowledgeThread(validateEntityId(assistantId, 'Assistant ID'))
  )

  /**
   * The getting-started checkpoint the authoring agent keeps current, for the
   * knowledge panel. Read-only: the interview's own turn owns the write.
   */
  ipcMain.handle('assistant:gettingStartedCheckpoint', (_, assistantId: unknown) => {
    const chatEngine = ctx.chatEngine
    if (!chatEngine) return null
    return chatEngine.readAssistantCheckpoint(validateEntityId(assistantId, 'Assistant ID'))
  })

  ipcMain.handle('assistant:setKnowledgeHidden', (_, assistantId: unknown, hidden: unknown) => {
    if (typeof hidden !== 'boolean') throw new TypeError('How-to hidden state must be a boolean')
    const thread = assistantManager.setKnowledgeHidden(
      validateEntityId(assistantId, 'Assistant ID'),
      hidden
    )
    // The row moved in or out of the archived set, so every renderer needs the
    // fresh thread to drop or restore the row without a reload.
    broadcastThreadUpdate(thread)
    return thread
  })

  ipcMain.handle('assistant:setTaskSchedule', (_, threadId: unknown, schedule: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const thread = assistantManager.setTaskScheduleOverride(
      safeThreadId,
      sanitizeSchedule(schedule)
    )
    // This is a task's own clock going on, off, or onto another schedule.
    assistantScheduler?.refreshSchedule()
    return thread
  })

  /**
   * Turn one function's clock on or off independently of its assistant: `true`
   * schedules it even under an unscheduled assistant, `false` keeps it off the
   * clock even under a scheduled one, and `null` returns it to its assistant's
   * default. The fresh row is broadcast so every renderer reads the new state
   * without a reload.
   */
  ipcMain.handle('assistant:setTaskScheduled', (_, threadId: unknown, scheduled: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    if (scheduled !== null && typeof scheduled !== 'boolean') {
      throw new TypeError('Task scheduled flag must be a boolean or null')
    }
    const thread = assistantManager.setTaskScheduled(safeThreadId, scheduled)
    broadcastThreadUpdate(thread)
    // The task's own clock was turned on or off.
    assistantScheduler?.refreshSchedule()
    return thread
  })

  ipcMain.handle('assistant:listMissedRuns', () => requireScheduler().listMissedRuns())

  ipcMain.handle('assistant:listSkippedRuns', () => requireScheduler().listSkippedRuns())

  ipcMain.handle('assistant:hasRunsToday', (_, assistantId: unknown) =>
    requireScheduler().hasRunsToday(validateEntityId(assistantId, 'Assistant ID'))
  )

  ipcMain.handle('assistant:skipNextRun', async (_, assistantId: unknown) => {
    const scheduler = requireScheduler()
    await scheduler.skipNextRun(validateEntityId(assistantId, 'Assistant ID'))
    return scheduler.listSkippedRuns()
  })

  ipcMain.handle('assistant:skipRunsToday', async (_, assistantId: unknown) => {
    const scheduler = requireScheduler()
    await scheduler.skipRunsToday(validateEntityId(assistantId, 'Assistant ID'))
    return scheduler.listSkippedRuns()
  })

  // The durable record of unattended runs. Read from the ledger, not the thread
  // table, so a run whose thread was evicted or deleted still reports what
  // happened on the "While you were away" surfaces.
  ipcMain.handle('assistant:listBackgroundRuns', () => requireScheduler().listBackgroundRuns())

  // Acknowledge one unattended run so it leaves the "While you were away"
  // surface for good. The ledger owns the durable removal; the fresh list is
  // pushed so every open panel and assistant history updates together.
  ipcMain.handle('assistant:dismissBackgroundRun', (_, id: unknown) => {
    const scheduler = requireScheduler()
    scheduler.dismissBackgroundRun(requireString(id, 'Background run ID').slice(0, 300))
    broadcastBackgroundRunsChanged(scheduler.listBackgroundRuns())
  })

  ipcMain.handle('assistant:listAutoAnswers', () => ctx.autoAnswerStore?.list() ?? [])

  /**
   * Dismiss one auto-resolved gate (or all of them). The store owns the durable
   * flag; the fresh list is pushed so every open attention panel updates, and
   * the amber rail icon leaves once nothing is left unread.
   */
  ipcMain.handle('assistant:dismissAutoAnswer', (_, id: unknown) => {
    const store = ctx.autoAnswerStore
    if (!store) return
    store.dismiss(requireString(id, 'Auto-answer ID').slice(0, 300))
    broadcastAutoAnswersChanged(store.list())
  })

  ipcMain.handle('assistant:dismissAllAutoAnswers', () => {
    const store = ctx.autoAnswerStore
    if (!store) return 0
    const dismissed = store.dismissAll()
    broadcastAutoAnswersChanged(store.list())
    return dismissed
  })

  /**
   * Post the saved-knowledge next-steps turn into the assistant's Getting started
   * thread. Hidden internal turn: the user sees the agent's prose list, never a
   * user bubble. An assistant with no Getting started thread, a hidden one, or a
   * thread with no bound settings makes this a no-op.
   */
  ipcMain.handle('assistant:postSetup', async (_, assistantId: unknown) => {
    const id = validateEntityId(assistantId, 'Assistant ID')
    const assistant = assistantManager.getAssistant(id)
    const thread = assistantManager.knowledgeThread(id)
    const chatEngine = ctx.chatEngine
    if (!assistant || !thread || thread.archived || !thread.settings || !chatEngine) return
    const primary = assistantPrimaryModel(assistant.agents)
    const settings = primary
      ? settingsWithAssistantModel(thread.settings, primary)
      : thread.settings
    await chatEngine.sendPrompt(
      thread.projectId,
      thread.id,
      settings,
      assistantNextStepsPrompt(assistantIsScheduled(assistant)),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  })

  /**
   * Send one app-owned opening turn into an assistant's Getting started thread.
   *
   * Both openings use the `user` origin even though the user did not type them:
   * that origin is what attaches the authoring contract, which rides the system
   * prompt of a user turn on an assistant whose knowledge is still missing. The
   * presentation line stands in for the prompt, so the user reads what is
   * happening instead of the instruction. An assistant with no Getting started
   * thread, a hidden one, or a thread with no bound settings makes this a no-op.
   */
  const postAssistantOpeningTurn = async (
    assistantId: string,
    text: string,
    action: string
  ): Promise<void> => {
    const assistant = assistantManager.getAssistant(assistantId)
    const thread = assistantManager.knowledgeThread(assistantId)
    const chatEngine = ctx.chatEngine
    if (!assistant || !thread || thread.archived || !thread.settings || !chatEngine) return
    const primary = assistantPrimaryModel(assistant.agents)
    const settings = primary
      ? settingsWithAssistantModel(thread.settings, primary)
      : thread.settings
    await chatEngine.sendPrompt(
      thread.projectId,
      thread.id,
      settings,
      text,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'user',
      { action }
    )
  }

  /**
   * Open a new assistant's first conversation when the user chose to build it by
   * talking rather than through the form. The assistant already exists and knows
   * nothing, so this posts the app-owned opening turn: the user reads one line
   * saying a new assistant is being created, and the model receives the setup
   * instruction, which is never shown.
   */
  ipcMain.handle('assistant:startChatSetup', async (_, assistantId: unknown) => {
    const id = validateEntityId(assistantId, 'Assistant ID')
    await postAssistantOpeningTurn(id, ASSISTANT_CHAT_SETUP_PROMPT, ASSISTANT_CHAT_SETUP_ACTION)
  })

  /**
   * Open a form-created assistant's first conversation. The name and the
   * personality are already the user's own words, so the assistant opens by using
   * them, asks only what to call the user, and says where a task goes.
   */
  ipcMain.handle('assistant:startManualSetup', async (_, assistantId: unknown) => {
    const id = validateEntityId(assistantId, 'Assistant ID')
    const assistant = assistantManager.getAssistant(id)
    if (!assistant) return
    await postAssistantOpeningTurn(
      id,
      assistantManualSetupPrompt(assistant),
      ASSISTANT_MANUAL_SETUP_ACTION
    )
  })

  ipcMain.handle('assistant:dismissMissedRun', (_, id: unknown) => {
    const scheduler = requireScheduler()
    scheduler.dismissMissedRun(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
  })

  ipcMain.handle('assistant:runMissedRunNow', async (_, id: unknown) => {
    const scheduler = requireScheduler()
    const run = await scheduler.runMissedRunNow(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
    return run
  })

  ipcMain.handle('assistant:runNow', async (_, assistantId: unknown) => {
    const scheduler = requireScheduler()
    return scheduler.runNow(validateEntityId(assistantId, 'Assistant ID'))
  })
}
