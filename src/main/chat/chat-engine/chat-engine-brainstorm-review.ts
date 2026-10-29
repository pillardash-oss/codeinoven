import { join } from 'path'
import type { BrainstormAlignmentRound } from '../brainstorm-alignment-notes'
import {
  BRAINSTORM_ALIGNMENT_UTILITY_ID,
  BRAINSTORM_CREATE_DOCUMENT_ANSWER,
  brainstormDocumentQuestion
} from '../../../lib/brainstorm/brainstorm-alignment'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type {
  BrainstormContent,
  BrainstormDocument,
  Thread,
  BrainstormPrototypeFidelity
} from '../../../lib/types'
import { workflowActionPresentation } from '../../../lib/workflow-action-presentation'
import { ensureFeatureSlug, requireLocalProject } from '../../../lib/project-artifacts'
import { rawErrorMessage } from './chat-engine-errors'
import { formatOpenAnnotations } from './chat-engine-prompts'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine brainstorm-review: one concern, moved verbatim from the composition root. */
export class ChatEngineBrainstormReview {
  constructor(private readonly host: ChatEngine) {}

  async reviewBrainstorm(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note: string,
    options: {
      sessionTurn?: boolean
      /** When set, forces prototype artifact generation for this revision. */
      prototypeRequest?: { fidelity: BrainstormPrototypeFidelity; count?: number }
    } = {}
  ): Promise<BrainstormDocument> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    brainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
    note = validateBoundedString(note, 'Brainstorm review note', 0, 20_000)
    if (!options.sessionTurn && !options.prototypeRequest) {
      const current = this.host.state.brainstormEngine.getVersion(
        projectId,
        threadId,
        brainstormId,
        version
      )
      if (!current || current.status !== 'draft') throw new Error('Brainstorm draft is unavailable')
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.settings) throw new Error('Sr. Engineer settings are missing')
      const reviewed = note.trim()
        ? await this.host.state.brainstormEngine.addDecisionComment(
            projectId,
            threadId,
            brainstormId,
            version,
            'review',
            note
          )
        : current
      await this.host.sendPrompt(
        projectId,
        threadId,
        thread.settings,
        [
          'Continue the Brainstorm interview using the current document, annotations, review text, and alignment notes. Research the points raised, discuss the intended direction, and ask focused questions. Do not generate a new document until alignment and explicit version-specific user approval.',
          note.trim() ? `User review:\n${note.trim()}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        [],
        'review',
        undefined,
        undefined,
        undefined,
        undefined,
        'user',
        workflowActionPresentation('Discuss Brainstorm', note)
      )
      return reviewed
    }
    const operationKey = `${projectId}:${threadId}`
    if (this.host.state.activeBrainstormOperations.has(operationKey)) {
      throw new Error('The Sr. Engineer is already updating this Brainstorm')
    }
    this.host.state.activeBrainstormOperations.add(operationKey)
    const refreshSessionId = `brainstorm-refresh-${brainstormId}-v${version}-${Date.now()}`
    let refreshHarnessId = DEFAULT_HARNESS
    if (options.sessionTurn) {
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: refreshSessionId,
        projectId,
        threadId,
        update: {
          type: 'refresh.started',
          startedAt: Date.now(),
          phase: 'refresh',
          version
        }
      })
    }
    try {
      const current = this.host.state.brainstormEngine.getVersion(
        projectId,
        threadId,
        brainstormId,
        version
      )
      if (!current || current.status !== 'draft') throw new Error('Brainstorm draft is unavailable')
      const lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
      if (lifecycle?.humanGate === 'prototype_selection' && lifecycle.resumeToken) {
        this.host.state.engineeringLifecycleEngine.resume(
          projectId,
          threadId,
          lifecycle.resumeToken,
          'continue',
          'brainstorm'
        )
      }
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.settings) throw new Error('Sr. Engineer settings are missing')
      refreshHarnessId = thread.settings.harnessId || DEFAULT_HARNESS
      await this.host.threadManager.setStatus(projectId, threadId, 'planning')
      const brainstormPath = await this.host.units['media-artifacts'].artifactRef(
        projectId,
        threadId,
        join('versions', `${current.id}-v${current.version}-brainstorm.md`)
      )
      const reviewNotes = [
        ...current.decisionComments
          .filter((comment) => comment.action === 'review')
          .map((comment) => `- ${comment.body}`),
        ...(note.trim() ? [`- ${note.trim()}`] : [])
      ].join('\n')
      let prototypesSkipped: string | null = null
      const content = await this.host.units['brainstorm-generate'].generateBrainstormContent(
        projectId,
        threadId,
        thread.settings,
        [
          options.prototypeRequest
            ? 'Generate the explicitly requested prototypes using the aligned intent, current Brainstorm document, annotations, review text, and alignment notes. Preserve the existing report text; this action attaches prototypes to the current document, not a new document version.'
            : options.sessionTurn
              ? 'Refresh the concise Brainstorm session report from the latest conversation. Read the current report, incorporate newly aligned decisions and findings, remove resolved items from Still to Decide, and preserve useful unchanged content.'
              : 'Revise the complete Brainstorm session report from the user review. Read the report at the referenced path and incorporate every open annotation and review note. Preserve useful unchanged content.',
          `Brainstorm document: ${brainstormPath}`,
          `Open annotations:\n${formatOpenAnnotations(current.annotations)}`,
          reviewNotes ? `Review notes:\n${reviewNotes}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        options.sessionTurn
          ? {
              announceProgress: false,
              allowPrototypeSkip: true,
              prototypeOverride: options.prototypeRequest,
              onPrototypesSkipped: (reason: string) => {
                prototypesSkipped = reason
              }
            }
          : {
              includeConversationContext: true,
              presentation: workflowActionPresentation('Review Brainstorm', note),
              allowPrototypeSkip: true,
              ...(options.prototypeRequest ? { prototypeOverride: options.prototypeRequest } : {}),
              onPrototypesSkipped: (reason: string) => {
                prototypesSkipped = reason
              }
            }
      )
      // Existing prototype entries must survive every revision: review edits
      // never target them, and dropping them would hide the prototype
      // selection gate and orphan the finalized artifacts.
      const existingPrototypes = current.content.prototypes ?? []
      const generatedPrototypes = (content.prototypes ?? []).filter(
        (prototype) => !existingPrototypes.some((existing) => existing.id === prototype.id)
      )
      const mergedContent: BrainstormContent =
        existingPrototypes.length > 0 || generatedPrototypes.length > 0
          ? { ...content, prototypes: [...existingPrototypes, ...generatedPrototypes] }
          : content
      let revised = options.prototypeRequest
        ? await this.host.state.brainstormEngine.saveDraft(
            projectId,
            threadId,
            brainstormId,
            version,
            {
              ...current.content,
              prototypes: mergedContent.prototypes
            }
          )
        : await this.host.state.brainstormEngine.createVersion({
            projectId,
            threadId,
            brainstormId,
            baseVersion: version,
            content: mergedContent,
            provenance: {
              source: 'agent',
              actor: 'Sr. Engineer',
              harnessId: thread.settings.harnessId,
              providerId: thread.settings.providerId,
              modelId: thread.settings.modelId
            }
          })
      if (note.trim()) {
        revised = await this.host.state.brainstormEngine.addDecisionComment(
          projectId,
          threadId,
          brainstormId,
          revised.version,
          'review',
          note
        )
      }
      if (prototypesSkipped) {
        revised = await this.host.state.brainstormEngine.addDecisionComment(
          projectId,
          threadId,
          brainstormId,
          revised.version,
          'review',
          `${prototypesSkipped}. Existing prototype entries were preserved; generate prototypes from a harness with scoped-write support.`
        )
      }
      await this.host.units['brainstorm'].publishBrainstormReady(revised, thread.sessionId)
      return revised
    } catch (error) {
      if (options.sessionTurn) {
        this.host.broadcast({
          type: 'brainstorm.trace',
          sessionId: refreshSessionId,
          projectId,
          threadId,
          update: {
            type: 'refresh.failed',
            error: rawErrorMessage(error),
            harnessId: refreshHarnessId
          }
        })
      }
      if (this.host.state.userAbortedBrainstormOperations.delete(operationKey)) {
        await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
        const unchanged = this.host.state.brainstormEngine.getVersion(
          projectId,
          threadId,
          brainstormId,
          version
        )
        if (unchanged) return unchanged
      }
      this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, error)
      await this.host.threadManager.setStatus(projectId, threadId, 'spec', { read: false })
      throw error
    } finally {
      if (options.sessionTurn) {
        this.host.broadcast({
          type: 'brainstorm.trace',
          sessionId: refreshSessionId,
          projectId,
          threadId,
          update: { type: 'refresh.completed' }
        })
      }
      this.host.state.activeBrainstormOperations.delete(operationKey)
    }
  }

  async saveBrainstormAlignmentNotes(
    projectId: string,
    threadId: string,
    sessionId: string,
    markdown: string
  ): Promise<{ path: string; version: number }> {
    const workflow = this.host.state.brainstormEngine.getWorkflowState(projectId, threadId)
    const turn = this.host.state.pendingBrainstormTurns.get(sessionId)
    if (workflow?.entryChoice !== 'brainstorm' || workflow.stage !== 'drafting' || !turn) {
      throw new Error('The Brainstorm interview is no longer active')
    }
    const round = await this.brainstormAlignmentRound(projectId, threadId)
    if (round.version !== (turn.version ?? 0) + 1) {
      throw new Error('The Brainstorm version changed; continue in a new interview turn')
    }
    return this.host.state.brainstormAlignmentNotes.save(round, markdown)
  }

  async brainstormAlignmentRound(
    projectId: string,
    threadId: string
  ): Promise<BrainstormAlignmentRound> {
    const active = await this.host.state.brainstormEngine.getActive(projectId, threadId)
    return {
      projectId,
      threadId,
      project: {
        ...requireLocalProject(this.host.database, projectId),
        path: await this.host.resolveThreadPath(projectId, threadId)
      },
      featureSlug: await ensureFeatureSlug(this.host.database, projectId, threadId),
      version: (active?.version ?? 0) + 1
    }
  }

  async brainstormAlignmentContext(
    projectId: string,
    threadId: string,
    interview: boolean
  ): Promise<string> {
    const round = await this.brainstormAlignmentRound(projectId, threadId)
    const current = await this.host.state.brainstormEngine.getActive(projectId, threadId)
    const notes = await this.host.state.brainstormAlignmentNotes.read(round)
    const previousPath =
      round.version > 1
        ? this.host.state.brainstormAlignmentNotes.path({ ...round, version: round.version - 1 })
        : ''
    return [
      `Alignment round for Brainstorm v${round.version}. Current notes: ${this.host.state.brainstormAlignmentNotes.path(round)}.`,
      previousPath
        ? `Previous alignment notes, when present: ${previousPath}. Read them alongside the current document before continuing. Older drafts may predate alignment notes; recover their intent from the original conversation and verify the draft's claims. Earlier round notes remain in the same directory as align-note-[n].md; read relevant earlier rationale when needed.`
        : '',
      current
        ? [
            `Current Brainstorm v${current.version}: ${await this.host.units['media-artifacts'].artifactRef(projectId, threadId, join('versions', `${current.id}-v${current.version}-brainstorm.md`))}. Read it before discussing or generating the next version.`,
            `Open annotations:\n${formatOpenAnnotations(current.annotations)}`,
            `Review/discuss notes:\n${
              current.decisionComments
                .filter((comment) => comment.action === 'review')
                .map((comment) => `- ${comment.body}`)
                .join('\n') || 'None.'
            }`
          ].join('\n\n')
        : 'No Brainstorm document exists yet. Interview and research first.',
      notes
        ? `Current alignment notes:\n${notes}`
        : 'No notes have been saved for this round yet. Preserve confirmed intent and research in the round notes.',
      interview
        ? [
            `Use ${BRAINSTORM_ALIGNMENT_UTILITY_ID} (activate it, then invoke save_notes with { markdown }) to save concise cumulative notes. The application writes only the designated align-note-${round.version}.md; do not write source files or a report yourself.`,
            'Research relevant code and external facts, explain findings, and interview the user until the intended experience, boundaries, decisions, and rationale are clear. Existing unanswered choices are interview topics, not permission to generate another draft.',
            'When aligned, save notes, give a short alignment recap, then ask exactly this single question using the question tool:',
            JSON.stringify({
              question: brainstormDocumentQuestion(round.version),
              header: 'Document',
              options: [
                {
                  label: BRAINSTORM_CREATE_DOCUMENT_ANSWER,
                  description: `Create Brainstorm v${round.version} from the agreed direction and research.`
                },
                {
                  label: 'Continue discussion',
                  description: 'Keep interviewing and researching before creating the document.'
                }
              ]
            }),
            'After approval, finish with a brief acknowledgement; the application generates the document once. Do not rewrite notes after approval unless the direction changes and a new approval is needed. Never claim a document was created before the application confirms it.'
          ].join('\n')
        : 'Use the current document, annotations, review/discuss text, and alignment notes as source context. Preserve the agreed intent and rationale, including for prototypes; do not invent decisions.'
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}
