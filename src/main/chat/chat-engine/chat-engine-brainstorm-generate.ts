import { readdir } from 'fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { toPosixPath } from '../../../lib/paths'
import {
  currentHarnessVersion,
  episodeFromPieces,
  tokenUsageAttribution
} from '../token-usage-attribution'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import { validateBoundedString } from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import type {
  BrainstormContent,
  UserMessagePresentation,
  ThreadSettings,
  BrainstormPrototypeFidelity
} from '../../../lib/types'
import {
  SAFE_PROTOTYPE_ID,
  finalizePrototypeArtifact,
  planPrototypeGeneration,
  resolvePrototypeArtifactPaths
} from '../../../lib/prototypes/prototype-artifacts'
import {
  prototypeCdnInstruction,
  prototypeCdnPolicyFromConfig
} from '../../../lib/prototypes/prototype-cdn'
import { BRAINSTORM_DOCUMENT_JSON_SCHEMA } from '../../../lib/brainstorm/brainstorm-validation'
import {
  ensureFeatureSlug,
  featureArtifactDirectory,
  requireLocalProject
} from '../../../lib/project-artifacts'
import type { ActiveBrainstormSession } from './chat-engine-types'
import { GeneratedBrainstormOutputError, GeneratedJsonParseError } from './chat-engine-errors'
import { BRAINSTORM_GENERATION_TIMEOUT_MS, traceLeanAgent } from './chat-engine-constants'
import {
  BRAINSTORM_DECISION_INTEGRITY_SYSTEM_PROMPT,
  BRAINSTORM_DOCUMENT_WRITE_TOOLS,
  BRAINSTORM_JSON_FALLBACK_SYSTEM_PROMPT,
  BRAINSTORM_RESEARCH_ALLOWED_TOOLS,
  brainstormDocumentWriteEnabled
} from './chat-engine-prompts'
import { parseGeneratedJson } from './chat-engine-generated-artifacts'
import { brainstormRepairInstruction, parseBrainstormGeneratedOutput } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine brainstorm-generate: one concern, moved verbatim from the composition root. */
export class ChatEngineBrainstormGenerate {
  constructor(private readonly host: ChatEngine) {}

  async generateBrainstormContent(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    instructions: string,
    options: {
      includeConversationContext?: boolean
      announceProgress?: boolean
      presentation?: UserMessagePresentation
      /** Continue without new prototype artifacts instead of failing when the
       *  harness cannot create scoped prototype files (review refreshes). */
      allowPrototypeSkip?: boolean
      /** Forces prototype artifact generation for this turn, bypassing intent
       *  detection on the source text. Count defaults to 1 per fidelity. */
      prototypeOverride?: { fidelity: BrainstormPrototypeFidelity; count?: number }
      onPrototypesSkipped?: (reason: string) => void
    } = {}
  ): Promise<BrainstormContent> {
    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, threadId)
    const behaviorPrompt = await this.host.units['turns-dispatch'].getBehaviorPrompt(
      projectId,
      threadId,
      projectPath,
      'brainstorm',
      settings,
      'ephemeral'
    )
    const validatedInstructions = validateBoundedString(
      instructions,
      'Brainstorm instructions',
      1,
      80_000
    )
    const source =
      options.includeConversationContext === false
        ? validatedInstructions
        : await this.host.units['brainstorm'].brainstormSourceWithConversationContext(
            projectId,
            threadId,
            validatedInstructions
          )
    if (options.announceProgress !== false) {
      await this.host.units['brainstorm'].beginBrainstormConversationTurn(
        projectId,
        threadId,
        source,
        options.presentation
      )
    }
    // Scoped-write route (P3-cp4): on opencode, supply the EXACT revision path
    // so the `cio-brainstorm` agent persists the session-report revision itself
    // through its path-scoped `edit` permission. The app still validates the
    // returned content via the cio_brainstorm_doc contract and records the
    // authoritative copy through BrainstormEngine.
    const brainstormWriteRoute = brainstormDocumentWriteEnabled(driverId, driver.capabilities)
    let revisionPathInstruction = ''
    let featureSlug: string | undefined
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
    // Historical discussion and annotations are context, not a new prototype
    // request. Only the explicit prototype action (or opted-in autopilot) owns it.
    const prototypeFidelity: BrainstormPrototypeFidelity | undefined =
      options.prototypeOverride?.fidelity ?? (lifecycle?.autopilot === true ? 'lofi' : undefined)
    const requestedPrototypeCount = options.prototypeOverride?.count
    const prototypeBatches =
      prototypeFidelity && prototypeFidelity !== undefined
        ? planPrototypeGeneration(prototypeFidelity, requestedPrototypeCount)
        : []
    if (brainstormWriteRoute) {
      featureSlug = await ensureFeatureSlug(this.host.database, projectId, threadId)
      // The preview server is serving the same approved origins, so the turn is
      // told exactly which external hosts will load and which will not.
      const prototypeCdnGuidance =
        prototypeBatches.length > 0
          ? prototypeCdnInstruction(
              prototypeCdnPolicyFromConfig(await this.host.storage.getConfig())
            )
          : ''
      const revisionRelativePath = toPosixPath(
        join(
          featureArtifactDirectory(featureSlug),
          'versions',
          `session-${Date.now()}-brainstorm.md`
        )
      )
      revisionPathInstruction = [
        '',
        'Session-report revision path (write the report Markdown to EXACTLY this project-relative path, creating parent directories as needed):',
        revisionRelativePath,
        ...(prototypeBatches.length > 0
          ? [
              '',
              prototypeCdnGuidance,
              ...prototypeBatches
                .flat()
                .map(
                  (item) =>
                    `Create ${item.fidelity} prototype ${item.id} at .cio/specs/${featureSlug}/prototypes/${item.id}/index.html and include matching metadata for ${item.id} in the Brainstorm prototypes collection.`
                ),
              'Do not write anywhere else. Keep each concept self-contained and visibly identified.'
            ]
          : [])
      ].join('\n')
    }
    const prototypeWriteCapable = brainstormWriteRoute && featureSlug !== undefined
    const skipPrototypeGeneration =
      prototypeBatches.length > 0 && !prototypeWriteCapable && options.allowPrototypeSkip === true
    const finish = async (content: BrainstormContent): Promise<BrainstormContent> => {
      let completed: BrainstormContent = {
        title: content.title,
        summary: content.summary,
        sections: content.sections
      }
      // Reconciliation runs on every write-capable brainstorm turn   not just
      // generation turns   so prototypes the model created ad hoc (or a
      // previous turn failed to register) still land in the document.
      if (brainstormWriteRoute && featureSlug !== undefined) {
        const declared = new Map(
          (content.prototypes ?? []).map((prototype) => [prototype.id, prototype])
        )
        const projectRoot = requireLocalProject(this.host.database, projectId).path
        const prototypes: NonNullable<BrainstormContent['prototypes']> = []
        for (const batch of prototypeBatches) {
          const finalized = await Promise.all(
            batch.map(async (item) => {
              const prototypeCandidate = declared.get(item.id)
              const artifact = await finalizePrototypeArtifact({
                projectRoot,
                featureSlug,
                prototypeId: item.id,
                fidelity: item.fidelity,
                title:
                  prototypeCandidate?.title ||
                  `${item.fidelity === 'lofi' ? 'LoFi' : 'HiFi'} ${item.id}`,
                entryFile: 'index.html',
                ...(prototypeCandidate?.parentPrototypeId
                  ? { parentPrototypeId: prototypeCandidate.parentPrototypeId }
                  : {})
              })
              const paths = resolvePrototypeArtifactPaths(projectRoot, featureSlug, item.id)
              await this.host.state.prototypePreviewRegistrar?.(
                paths.previewSlug,
                paths.canonicalRoot
              )
              return artifact
            })
          )
          prototypes.push(...finalized)
        }
        // The model may create prototypes beyond the declared batch (e.g. an
        // extra concept it invented mid-turn). Discover any valid prototype
        // directories on disk that the plan did not cover and finalize them
        // so nothing the model actually built is silently dropped.
        const prototypesRoot = resolve(projectRoot, '.cio', 'specs', featureSlug, 'prototypes')
        const plannedIds = new Set(prototypeBatches.flat().map((item) => item.id))
        let discovered: Dirent[] = []
        try {
          discovered = (await readdir(prototypesRoot, { withFileTypes: true }))
            .filter(
              (entry) =>
                entry.isDirectory() &&
                SAFE_PROTOTYPE_ID.test(entry.name) &&
                !plannedIds.has(entry.name)
            )
            .sort((a, b) => a.name.localeCompare(b.name))
        } catch {
          // No prototypes directory: nothing extra to discover.
        }
        for (const entry of discovered) {
          const candidate = declared.get(entry.name)
          const artifact = await finalizePrototypeArtifact({
            projectRoot,
            featureSlug,
            prototypeId: entry.name,
            fidelity: prototypeFidelity ?? 'lofi',
            title: candidate?.title || `Prototype ${entry.name}`,
            entryFile: 'index.html',
            ...(candidate?.parentPrototypeId
              ? { parentPrototypeId: candidate.parentPrototypeId }
              : {})
          })
          const paths = resolvePrototypeArtifactPaths(projectRoot, featureSlug, entry.name)
          await this.host.state.prototypePreviewRegistrar?.(paths.previewSlug, paths.canonicalRoot)
          prototypes.push(artifact)
        }
        if (prototypes.length > 0) {
          completed = { ...completed, prototypes }
        }
      } else if (prototypeBatches.length > 0) {
        if (!skipPrototypeGeneration) {
          throw new Error('This harness cannot create scoped prototype artifacts')
        }
        // Review refreshes must still land their version bump: skip new
        // prototype artifacts and let the caller carry existing ones forward.
        const reason = 'This harness cannot create scoped prototype artifacts'
        Logger.error('Skipping brainstorm prototype generation', { projectId, threadId, reason })
        options.onPrototypesSkipped?.(reason)
      }
      await this.host.units['brainstorm'].completeBrainstormConversationTurn(
        projectId,
        threadId,
        completed,
        settings
      )
      return completed
    }
    const structuredOutputKey = `${driverId}:${settings.providerId}:${settings.modelId}`
    const isZenFreeModel =
      driverId === 'opencode' &&
      settings.providerId === 'opencode' &&
      settings.modelId.endsWith('-free')
    const structured =
      driver.capabilities?.structuredOutput === true &&
      !isZenFreeModel &&
      !this.host.state.unsupportedStructuredOutputModels.has(structuredOutputKey)
    let lastError: Error | null = null
    let repairError: GeneratedBrainstormOutputError | null = null

    const attempts = structured
      ? ['structured', 'json', 'json_repair']
      : ['json', 'json_repair', 'json_repair']
    const operationKey = `${projectId}:${threadId}`
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const useStructuredOutput = attempt === 'structured'
      const isolated = supportsIsolatedSessions(driver)
        ? await driver.createIsolatedSession(projectPath, `Brainstorm ${new Date().toISOString()}`)
        : undefined
      const sessionId =
        isolated?.sessionId ??
        (await driver.createSession(projectPath, `Brainstorm ${new Date().toISOString()}`))
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        'auto_review',
        driverId,
        undefined,
        true
      )
      const activeSession: ActiveBrainstormSession = {
        sessionId,
        driver,
        driverId,
        projectPath,
        ...(isolated ? { isolated } : {})
      }
      this.host.state.activeBrainstormSessions.set(operationKey, activeSession)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        BRAINSTORM_GENERATION_TIMEOUT_MS,
        'Brainstorm generation'
      )
      try {
        const brainstormSystemPrompt = [
          useStructuredOutput
            ? await this.host.units['turns-dispatch'].cioPrompt('brainstorm-document')
            : [
                await this.host.units['turns-dispatch'].cioPrompt('brainstorm-document'),
                BRAINSTORM_JSON_FALLBACK_SYSTEM_PROMPT
              ].join('\n\n'),
          BRAINSTORM_DECISION_INTEGRITY_SYSTEM_PROMPT,
          prototypeBatches.length > 0 && !skipPrototypeGeneration
            ? 'Prototype content is part of this Brainstorm. Include only the requested prototype entries.'
            : 'No new prototype artifacts are generated in this turn. Do not include a prototypes field, prototype section, placeholder, or prototype wording.',
          behaviorPrompt
        ]
          .filter(Boolean)
          .join('\n\n')
        // Scoped-write route (P3-cp4): on opencode the `cio-brainstorm` agent
        // permission scopes `edit` to `.cio/specs/*/versions/**` natively; on
        // any other driver that streams permission-asked events to the app,
        // the same auto_review PermissionPolicy forced on this prompt already
        // scopes the write (auto-approve unless the path is protected). The
        // app still validates the returned content via the cio_brainstorm_doc
        // contract either way. A driver with neither channel keeps the
        // read-only sandbox.
        const brainstormWriteRoute = brainstormDocumentWriteEnabled(driverId, driver.capabilities)
        const prompt: SendPromptOptions = {
          sessionId,
          settings: {
            ...settings,
            permissionLevel: 'auto_review',
            assignmentMode: false,
            loopMode: false
          },
          text: [
            source,
            revisionPathInstruction,
            repairError ? brainstormRepairInstruction(repairError) : ''
          ]
            .filter(Boolean)
            .join('\n\n'),
          attachments: [],
          systemPrompt: brainstormSystemPrompt,
          allowedTools: brainstormWriteRoute
            ? BRAINSTORM_DOCUMENT_WRITE_TOOLS
            : BRAINSTORM_RESEARCH_ALLOWED_TOOLS,
          readOnly: !brainstormWriteRoute,
          agent: leanAgentNameForMode('brainstorm'),
          ...(useStructuredOutput
            ? {
                structuredOutput: {
                  schema: BRAINSTORM_DOCUMENT_JSON_SCHEMA,
                  retryCount: 2
                }
              }
            : {})
        }
        tokenUsageAttribution.recordPromptAttribution(
          episodeFromPieces({
            key: `brainstorm:${sessionId}`,
            mode: 'brainstorm',
            driverId,
            pieces: [
              { title: 'Brainstorm system prompt', content: brainstormSystemPrompt },
              { title: 'Brainstorm source', content: prompt.text }
            ]
          })
        )
        traceLeanAgent('brainstorm', sessionId, driverId)
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.sendPrompt(projectPath, prompt, isolated)
        } else {
          await driver.sendPrompt(projectPath, prompt)
        }
        const streamed = await completion
        if (streamed !== undefined) {
          return finish(parseBrainstormGeneratedOutput(streamed, useStructuredOutput))
        }
        const generated =
          isolated && supportsIsolatedSessions(driver)
            ? await driver.loadMessages(projectPath, sessionId, isolated)
            : await driver.loadMessages(projectPath, sessionId)
        const response = [...generated].reverse().find((message) => message.role === 'assistant')
        if (!response) throw new Error('The Brainstorm agent returned no response')
        if (response.error) throw new Error(response.error)
        tokenUsageAttribution.recordTurnTotals({
          key: `brainstorm:${sessionId}`,
          agent: leanAgentNameForMode('brainstorm'),
          driverId,
          harnessVersion: currentHarnessVersion(),
          providerId: response.providerId ?? settings.providerId ?? null,
          modelId: response.modelId ?? settings.modelId ?? null,
          reportedInputTokens: response.normalizedUsage?.uncachedInput ?? null,
          reportedTotalTokens: response.normalizedUsage?.rawTotal ?? null
        })
        if (response.structuredOutput !== undefined) {
          return finish(
            parseBrainstormGeneratedOutput(response.structuredOutput, useStructuredOutput)
          )
        }
        const text = response.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        return finish(
          parseBrainstormGeneratedOutput(
            parseGeneratedJson(text, 'The Brainstorm agent returned invalid JSON'),
            false
          )
        )
      } catch (error) {
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.abort(projectPath, sessionId, isolated).catch(() => undefined)
        } else {
          await driver.abort(projectPath, sessionId).catch(() => undefined)
        }
        const rejectedSource =
          error instanceof GeneratedBrainstormOutputError
            ? error
            : error instanceof GeneratedJsonParseError
              ? new GeneratedBrainstormOutputError(error.message, error.rawOutput)
              : null
        const rejected = rejectedSource
          ? await this.host.units['brainstorm'].prepareRejectedBrainstormRepair({
              projectId,
              threadId,
              attempt: attemptIndex + 1,
              format: useStructuredOutput ? 'structured' : 'json',
              settings,
              error: rejectedSource
            })
          : null
        lastError =
          rejected ?? (error instanceof Error ? error : new Error('The Brainstorm agent failed.'))
        if (rejected) repairError = rejected
        if (this.host.state.userAbortedBrainstormOperations.has(operationKey)) {
          await this.host.units['brainstorm'].failBrainstormConversationTurn(
            projectId,
            threadId,
            lastError,
            settings
          )
          throw lastError
        }
        Logger.error('Brainstorm generation session rejected', {
          projectId,
          threadId,
          sessionId,
          structuredOutput: useStructuredOutput,
          error: lastError.message
        })
        if (useStructuredOutput) {
          this.host.state.unsupportedStructuredOutputModels.add(structuredOutputKey)
          Logger.info('Structured Brainstorm generation failed; using JSON-only output:', {
            driverId,
            providerId: settings.providerId,
            modelId: settings.modelId,
            error: lastError.message
          })
        }
      } finally {
        await this.host.units['messages-write'].recordEphemeralSessionUsage({
          projectId,
          threadId,
          sessionId,
          projectPath,
          driver,
          isolated
        })
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        this.host.sessionRegistry.delete(sessionId)
        this.host.state.reasoningTimes.delete(sessionId)
        this.host.state.toolTimes.delete(sessionId)
        if (this.host.state.activeBrainstormSessions.get(operationKey)?.sessionId === sessionId) {
          this.host.state.activeBrainstormSessions.delete(operationKey)
        }
        if (isolated && supportsIsolatedSessions(driver)) driver.disposeIsolatedSession(isolated)
      }
    }
    const failure = repairError ?? lastError ?? new Error('The Brainstorm agent failed.')
    await this.host.units['brainstorm'].failBrainstormConversationTurn(
      projectId,
      threadId,
      failure,
      settings
    )
    throw failure
  }
}
