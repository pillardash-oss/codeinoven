import { join } from 'path'
import type {
  AgentMessage,
  BrainstormDocument,
  PrdDocument,
  EngineeringSpec,
  ThreadSettings
} from '../../../lib/types'
import type { PendingInitialSpecGeneration, PendingSpecRevision } from './chat-engine-types'
import { CURRENT_SPEC_GENERATION_VERSION } from './chat-engine-constants'
import {
  parseGeneratedSpecContent,
  validateGeneratedSpecContent
} from './chat-engine-generated-artifacts'
import { initialSpecPath, pendingSpecRevisionPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine spec-lifecycle: one concern, moved verbatim from the composition root. */
export class ChatEngineSpecLifecycle {
  constructor(private readonly host: ChatEngine) {}

  readPendingInitialSpec(
    projectId: string,
    threadId: string
  ): Promise<PendingInitialSpecGeneration | null> {
    return this.host.storage
      .read<PendingInitialSpecGeneration>(initialSpecPath(projectId, threadId))
      .then((persisted) =>
        persisted ? { ...persisted, generationVersion: CURRENT_SPEC_GENERATION_VERSION } : null
      )
  }

  async queuePendingInitialSpec(input: {
    projectId: string
    threadId: string
    sessionId: string
    source: string
    settings: ThreadSettings
    brainstorm?: BrainstormDocument
    prd?: PrdDocument
    skipSubmittedRead?: boolean
  }): Promise<void> {
    const existing = await this.readPendingInitialSpec(input.projectId, input.threadId)
    const now = Date.now()
    await this.host.units['spec-authoring'].writePendingInitialSpec(
      existing
        ? {
            ...existing,
            generationVersion: CURRENT_SPEC_GENERATION_VERSION,
            sessionId: input.sessionId,
            source: input.source,
            settings: structuredClone(input.settings),
            state: 'pending',
            attempts: 0,
            error: undefined,
            createdAt: now,
            brainstormId: input.brainstorm?.id,
            brainstormVersion: input.brainstorm?.version,
            brainstormInputHash: input.brainstorm?.finalizedInputHash,
            prdId: input.prd?.id,
            prdVersion: input.prd?.version,
            prdInputHash: input.prd?.finalizedInputHash,
            skipSubmittedRead: input.skipSubmittedRead ?? false,
            updatedAt: now
          }
        : {
            schemaVersion: 1,
            generationVersion: CURRENT_SPEC_GENERATION_VERSION,
            projectId: input.projectId,
            threadId: input.threadId,
            sessionId: input.sessionId,
            source: input.source,
            settings: structuredClone(input.settings),
            brainstormId: input.brainstorm?.id,
            brainstormVersion: input.brainstorm?.version,
            brainstormInputHash: input.brainstorm?.finalizedInputHash,
            prdId: input.prd?.id,
            prdVersion: input.prd?.version,
            prdInputHash: input.prd?.finalizedInputHash,
            skipSubmittedRead: input.skipSubmittedRead ?? false,
            state: 'pending',
            attempts: 0,
            createdAt: now,
            updatedAt: now
          }
    )
  }

  clearPendingInitialSpec(projectId: string, threadId: string): Promise<void> {
    return this.host.storage.remove(initialSpecPath(projectId, threadId))
  }

  readPendingSpecRevision(
    projectId: string,
    threadId: string
  ): Promise<PendingSpecRevision | null> {
    return this.host.storage.read<PendingSpecRevision>(pendingSpecRevisionPath(projectId, threadId))
  }

  clearPendingSpecRevision(projectId: string, threadId: string): Promise<void> {
    return this.host.storage.remove(pendingSpecRevisionPath(projectId, threadId))
  }

  runPendingInitialSpec(projectId: string, threadId: string): Promise<EngineeringSpec | null> {
    const key = this.host.units['spec'].initialSpecKey(projectId, threadId)
    const existing = this.host.state.initialSpecTasks.get(key)
    if (existing) return existing
    const task = this.host.units['spec-authoring'].generatePendingInitialSpec(projectId, threadId)
    this.host.state.initialSpecTasks.set(key, task)
    void task.then(
      () => {
        if (this.host.state.initialSpecTasks.get(key) === task) {
          this.host.state.initialSpecTasks.delete(key)
        }
      },
      () => {
        if (this.host.state.initialSpecTasks.get(key) === task) {
          this.host.state.initialSpecTasks.delete(key)
        }
      }
    )
    return task
  }

  runPendingSpecRevision(
    sessionId: string,
    messages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<EngineeringSpec | null> {
    const existing = this.host.state.specRevisionTasks.get(sessionId)
    if (existing) return existing
    const task = this.persistPendingSpecRevision(sessionId, messages, scope)
    this.host.state.specRevisionTasks.set(sessionId, task)
    void task.then(
      () => {
        if (this.host.state.specRevisionTasks.get(sessionId) === task) {
          this.host.state.specRevisionTasks.delete(sessionId)
        }
      },
      () => {
        if (this.host.state.specRevisionTasks.get(sessionId) === task) {
          this.host.state.specRevisionTasks.delete(sessionId)
        }
      }
    )
    return task
  }

  async persistPendingSpecRevision(
    sessionId: string,
    loadedMessages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<EngineeringSpec | null> {
    const pending =
      this.host.state.pendingSpecRevisions.get(sessionId) ??
      (scope ? await this.readPendingSpecRevision(scope.projectId, scope.threadId) : null)
    if (!pending || pending.sessionId !== sessionId) return null
    this.host.state.pendingSpecRevisions.delete(sessionId)
    this.host.state.pendingBrainstormTurns.delete(sessionId)
    await this.clearPendingSpecRevision(pending.projectId, pending.threadId)

    const current = await this.host.units['spec'].getActiveSpec(pending.projectId, pending.threadId)
    if (!current || current.id !== pending.specId || current.version !== pending.baseVersion) {
      throw new Error(
        'The active specification changed while the agent was revising it. Review the latest version and retry.'
      )
    }

    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      pending.harnessId,
      this.host.sessionRegistry.get(sessionId)?.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${pending.harnessId}`)
    const projectPath =
      this.host.sessionRegistry.get(sessionId)?.projectPath ??
      (await this.host.resolveThreadPath(pending.projectId, pending.threadId))
    const messages = loadedMessages ?? (await driver.loadMessages(projectPath, sessionId))
    const response = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!response) throw new Error('The specification agent returned no response')
    if (response.error) throw new Error(response.error)

    const content =
      response.structuredOutput !== undefined
        ? validateGeneratedSpecContent(
            response.structuredOutput,
            current.content.assignment !== undefined
          )
        : parseGeneratedSpecContent(
            response.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
            current.content.assignment !== undefined
          )
    const revised = await this.host.state.specEngine.createVersion({
      projectId: pending.projectId,
      threadId: pending.threadId,
      specId: pending.specId,
      content,
      provenance: {
        source: 'agent',
        actor: 'spec-agent',
        harnessId: pending.harnessId,
        providerId: pending.providerId,
        modelId: pending.modelId
      },
      context: current.context
    })
    await this.host.threadManager.setStatus(pending.projectId, pending.threadId, 'spec', {
      read: false
    })
    this.host.broadcast({
      type: 'spec.ready',
      sessionId,
      projectId: pending.projectId,
      threadId: pending.threadId,
      specId: revised.id,
      version: revised.version
    })
    return revised
  }
}
