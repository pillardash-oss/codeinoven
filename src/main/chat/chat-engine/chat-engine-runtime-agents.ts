import { resolve } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type {
  AgentModelSelection,
  ModelIdentity,
  ScopedHarnessCommand,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { computePromptBudget } from '../../../lib/prompt-budget'
import type { AuxiliaryRoute } from './chat-engine-types'
import { scopeHarnessCommands } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine runtime-agents: one concern, moved verbatim from the composition root. */
export class ChatEngineRuntimeAgents {
  constructor(private readonly host: ChatEngine) {}

  /**
   * The model identity a vision-capability report is attributed to: the model
   * that was executing the turn when the descriptor ran. Shared by the error
   * card and by a report that arrives after the card already settled.
   */
  visionReportModel(settings: ThreadSettings | undefined): ModelIdentity | undefined {
    if (!settings) return undefined
    return {
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId
    }
  }

  /**
   * Harness-correct settings for one auxiliary session. The session runs on the
   * assigned harness with only the assigned model as its candidate, and keeps
   * the same sandbox the harness-native cheap path uses: no tools, minimal
   * reasoning, automatic permission handling.
   */
  buildAuxiliaryRoute(
    selection: AgentModelSelection,
    accountId: string,
    driver: HarnessDriver,
    projectPath: string
  ): AuxiliaryRoute {
    return {
      driver,
      projectPath,
      harnessId: selection.harnessId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      candidates: [{ providerId: selection.providerId, modelId: selection.modelId }],
      settings: {
        harnessId: selection.harnessId,
        accountId,
        providerId: selection.providerId,
        modelId: selection.modelId,
        inferenceMode: selection.inferenceMode,
        contextWindow: selection.contextWindow,
        thinkingLevel: selection.thinkingLevel ?? 'minimal',
        permissionLevel: 'auto_review',
        assignmentMode: false,
        loopMode: false
      }
    }
  }

  /**
   * Input budget for the selected model: its context window minus the output
   * and tool headroom once. The reserved output is the model's own maximum
   * output when the catalog reports it, because a provider bills that
   * completion against the same window   reserving the app's small default for
   * a model that can emit hundreds of thousands of tokens would let the request
   * grow past what the provider accepts. Falls back to the default window when
   * the model is unknown or the catalog is unavailable.
   */
  selectedModelInputBudget(
    providerId: string | undefined,
    modelId: string | undefined,
    projectId: string
  ): number {
    let contextWindow: number | undefined
    let maxOutputTokens: number | undefined
    if (providerId && modelId) {
      try {
        const cached = this.host.state.providerCache.get(projectId)
        const model = cached
          ?.flatMap((catalog) => catalog.models)
          .find((model) => model.providerId === providerId && model.id === modelId)
        contextWindow = model?.contextWindow
        maxOutputTokens = model?.maxOutputTokens
      } catch {
        // Catalog unavailable   fall back to the default window.
      }
    }
    // Never let a corrupt catalog record reserve so much output that no input
    // fits: a reserve above half the window is implausible, so the default
    // applies instead.
    const reportedWindow = contextWindow ?? 0
    const outputTokens =
      maxOutputTokens !== undefined && reportedWindow > 0 && maxOutputTokens < reportedWindow / 2
        ? maxOutputTokens
        : undefined
    return computePromptBudget({ contextWindow, outputTokens }).availableInputTokens
  }

  /**
   * List slash commands exposed by the thread's active harness.
   *
   * `harnessId` overrides the thread's persisted harness. Temporary side chats
   * own no Thread row and pick their harness in the composer before their first
   * turn, so their view supplies the parent thread for project/scope resolution
   * together with the side chat's own harness.
   */
  async listCommands(
    projectId: string,
    threadId: string,
    harnessId?: string
  ): Promise<ScopedHarnessCommand[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const harnessOverride =
      harnessId === undefined ? undefined : validateBoundedString(harnessId, 'Harness ID', 1, 64)
    // A thread created optimistically may still be finalizing its DB row; wait
    // for persistence before querying it, mirroring ensureSession/sendMessage.
    await this.host.threadCreation?.awaitReady(threadId)
    if (this.host.threadCreation?.didFinalizationFail(threadId)) {
      throw new Error(`Thread not found: ${threadId} (its creation did not complete)`)
    }
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const driverId = harnessOverride ?? thread.settings?.harnessId ?? DEFAULT_HARNESS
    // An override can name a harness this install cannot run (the composer
    // offers every known harness). Fail closed to an app-only menu instead of
    // rejecting the whole query.
    const scope = await this.host.resolve(projectId, driverId, threadId).catch((error: unknown) => {
      Logger.info('Harness command resolution skipped', {
        driverId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    })
    if (!scope) return []
    const { driver, projectPath } = scope
    if (!driver.capabilities?.commands) return []

    try {
      return scopeHarnessCommands(
        driver.id,
        await this.host.units['providers-harness'].discoverHarnessCommands(driver, projectPath)
      )
    } catch (error) {
      Logger.info('Harness command discovery skipped', {
        driverId: driver.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  }

  /** Execute a harness slash command in the thread's session. */
  async runCommand(
    projectId: string,
    threadId: string,
    commandId: string,
    args: string
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    commandId = validateBoundedString(commandId, 'Command ID', 1, 768)
    args = validateBoundedString(args, 'Command arguments', 0, 16_384)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.sessionId) throw new Error('No active session for this thread')
    if (!thread.settings) throw new Error('Select a model before running a command')
    const driverId = thread.settings?.harnessId ?? DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, threadId)
    if (!driver.capabilities?.commands) {
      throw new Error(`${driver.name} does not support slash commands`)
    }
    const exposed = scopeHarnessCommands(
      driver.id,
      await this.host.units['providers-harness'].discoverHarnessCommands(driver, projectPath)
    )
    const command = exposed.find((candidate) => candidate.id === commandId)
    if (!command) throw new Error(`Command is not available in ${driver.name}`)
    await driver.runCommand(projectPath, thread.sessionId, command, args, thread.settings)
  }

  /** True when the selected model is explicitly marked as text-only by its catalog
   *  and the app's own vision record does not say otherwise. A model the user
   *  reported as seeing images (e.g. a provider misreports vision) is treated as
   *  vision-capable across every harness and provider, so the image descriptor
   *  never runs for it and its context stays unpolluted. */
  async modelLacksVision(projectId: string, settings: ThreadSettings): Promise<boolean> {
    const catalogs =
      this.host.state.providerCache.get(projectId) ??
      this.host.state.sharedProviderCatalog?.catalogs ??
      (await this.host.units['providers-accounts'].loadPersistedProviders())
    const provider =
      catalogs?.find(
        (candidate) =>
          candidate.harnessId === settings.harnessId && candidate.id === settings.providerId
      ) ?? catalogs?.find((candidate) => candidate.id === settings.providerId)
    const model = provider?.models.find((candidate) => candidate.id === settings.modelId)
    if (model?.attachment !== false) return false
    return !(await this.host.storage.hasVisionModel(settings.modelId))
  }

  /**
   * Whether the model executing this turn can see images itself, resolved live
   * for the utility gateway. Consumes the same rule as `modelLacksVision`, so
   * the prompt note, the gateway's reachable utilities and the descriptor
   * executor can never disagree about one model.
   */
  async executingModelVisionCapable(projectId: string, settings: ThreadSettings): Promise<boolean> {
    return !(await this.modelLacksVision(projectId, settings))
  }

  /** Last-resort image-descriptor model: the first vision-capable model in the
   *  cached catalog, so the tool works even when nothing was configured. */
  firstVisionModelFromCache(projectId: string): AgentModelSelection | undefined {
    const catalogs =
      this.host.state.providerCache.get(projectId) ??
      this.host.state.sharedProviderCatalog?.catalogs ??
      null
    for (const catalog of catalogs ?? []) {
      const model = catalog.models.find((candidate) => candidate.attachment === true)
      if (model) return { harnessId: catalog.harnessId, providerId: catalog.id, modelId: model.id }
    }
    return undefined
  }

  /** Human-readable label for an image-descriptor vision model, falling back to
   *  the raw ids when the catalog has not resolved the names yet. */
  visionModelLabel(projectId: string, selection: AgentModelSelection): string {
    const catalogs =
      this.host.state.providerCache.get(projectId) ??
      this.host.state.sharedProviderCatalog?.catalogs ??
      null
    const provider =
      catalogs?.find(
        (candidate) =>
          candidate.harnessId === selection.harnessId && candidate.id === selection.providerId
      ) ?? catalogs?.find((candidate) => candidate.id === selection.providerId)
    const model = provider?.models.find((candidate) => candidate.id === selection.modelId)
    if (!provider) return `${selection.harnessId} / ${selection.providerId} / ${selection.modelId}`
    return `${provider.name ?? selection.providerId} / ${model?.name ?? selection.modelId}`
  }
}
