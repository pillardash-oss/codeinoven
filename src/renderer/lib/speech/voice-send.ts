/**
 * Voice transcript delivery.
 *
 * When a dictation is sent on the user's behalf the composer it belongs to is
 * often gone — the user armed the send from another thread, or navigated away
 * while the model was still transcribing. This module is the one place that
 * knows how to put that message into the thread anyway:
 *
 * - the thread's agent is idle ⇒ dispatch now (the chat engine steers a live
 *   turn, so a dispatch that lands mid-turn is a steer, never a collision);
 * - the thread's agent is busy ⇒ park it in the recovery queue, which the
 *   background queued-message dispatcher delivers on the next idle transition.
 *
 * Nothing here guesses at composer state: the unsent content is read from the
 * same recovery mirror the mounted composer writes to, and only cleared once
 * delivery settled. Every failure keeps the text where the user can see it.
 */
import { invoke } from '$lib/ipc.svelte'
import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import {
  sendThreadMessageHeadless,
  threadAgentIsIdle,
  type HeadlessThreadMessage
} from '$lib/stores/thread-delivery'
import { logRendererError } from '$lib/system/renderer-logger'
import { INBOX_PROJECT_ID } from '$shared/types'
import type { SpeechScope } from '$shared/speech/types'
import type { QueuedResponseReference } from '$lib/stores/renderer-recovery'
import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference
} from '$shared/types'

/** The unsent composer content the renderer mirrors for a thread. */
export interface UnsentComposerContent extends HeadlessThreadMessage {
  attachments: PromptAttachment[]
  projectReferences: PromptProjectReference[]
  taskReferences: PromptAssignmentTaskReference[]
  promptReferences: QueuedResponseReference[]
}

type ComposerResetListener = (projectId: string, threadId: string) => void

const composerResetListeners = new Set<ComposerResetListener>()

/**
 * Register a mounted conversation view so a headless voice delivery can tell it
 * to drop the text it just took over — the composer's own buffer is stale the
 * moment the message is dispatched behind its back.
 */
export function onVoiceComposerReset(listener: ComposerResetListener): () => void {
  composerResetListeners.add(listener)
  return () => {
    composerResetListeners.delete(listener)
  }
}

function notifyComposerReset(projectId: string, threadId: string): void {
  for (const listener of composerResetListeners) {
    try {
      listener(projectId, threadId)
    } catch (cause) {
      logRendererError('A composer reset listener failed after a voice send.', cause)
    }
  }
}

/**
 * The thread a dictation scope writes into, or null for global overlays and
 * scopes that never own a composer.
 */
export function voiceScopeTarget(
  scope: SpeechScope
): { projectId: string; threadId: string } | null {
  if (scope.kind === 'global' || !scope.threadId) return null
  const projectId = scope.kind === 'project' ? scope.projectId : INBOX_PROJECT_ID
  return { projectId, threadId: scope.threadId }
}

/** Snapshot a thread's unsent composer content, or null when there is none. */
export function unsentComposerContent(scope: SpeechScope): UnsentComposerContent | null {
  const target = voiceScopeTarget(scope)
  if (!target) return null
  const { projectId, threadId } = target
  const content: UnsentComposerContent = {
    text: rendererRecovery.draftFor(projectId, threadId),
    attachments: rendererRecovery.attachmentsFor(projectId, threadId),
    projectReferences: rendererRecovery.projectReferencesFor(projectId, threadId),
    taskReferences: rendererRecovery.taskReferencesFor(projectId, threadId),
    promptReferences: rendererRecovery.draftPromptReferences(projectId, threadId)
  }
  const empty =
    content.text.trim().length === 0 &&
    content.attachments.length === 0 &&
    content.projectReferences.length === 0 &&
    content.taskReferences.length === 0 &&
    content.promptReferences.length === 0
  return empty ? null : content
}

/** Drop the text a delivery already took over, and release the composer. */
function settleDeliveredContent(projectId: string, threadId: string): void {
  rendererRecovery.clearDraft(projectId, threadId)
  notifyComposerReset(projectId, threadId)
}

/** Park the message for the next idle transition of its thread. */
function parkForIdleDispatch(
  projectId: string,
  threadId: string,
  content: UnsentComposerContent
): void {
  rendererRecovery.setQueuedMessage(projectId, threadId, {
    text: content.text,
    attachments: content.attachments,
    ...(content.promptContext ? { promptContext: content.promptContext } : {}),
    promptReferences: content.promptReferences,
    projectReferences: content.projectReferences,
    taskReferences: content.taskReferences,
    startAfterThreads: []
  })
}

/**
 * Whether the conversation a dictation belongs to still exists. A thread
 * deleted mid-transcription, or a side chat that closed, must keep the
 * transcript where the user can recover it instead of failing opaquely.
 */
async function conversationExists(projectId: string, threadId: string): Promise<boolean> {
  try {
    return (await invoke('thread:get', projectId, threadId)) !== null
  } catch {
    return false
  }
}

/**
 * Deliver unsent composer content for a thread that may have no mounted view.
 * `direct` sends immediately (a steer into a live turn); otherwise the message
 * queues behind a running turn instead of interrupting it. Returns with the
 * text it took over, or null when nothing was handed to the thread.
 */
async function dispatchUnsentContent(
  scope: SpeechScope,
  content: UnsentComposerContent,
  direct: boolean
): Promise<string | null> {
  const target = voiceScopeTarget(scope)
  if (!target) return null
  const { projectId, threadId } = target
  if (!(await conversationExists(projectId, threadId))) {
    reportVoiceDeliveryFailure(
      'That conversation is no longer available, so the voice message was not sent.'
    )
    return null
  }
  if (direct || (await threadAgentIsIdle(projectId, threadId))) {
    await sendThreadMessageHeadless(projectId, threadId, content)
  } else {
    parkForIdleDispatch(projectId, threadId, content)
  }
  settleDeliveredContent(projectId, threadId)
  return content.text
}

/** Report a failed voice delivery without ever dropping the transcript. */
function reportVoiceDeliveryFailure(message: string, cause?: unknown): void {
  const detail = cause === undefined ? '' : cause instanceof Error ? cause.message : String(cause)
  logRendererError(`${message}${detail ? ` ${detail}` : ''}`)
  try {
    reportErrorWithDetails(message, detail ? { details: detail } : undefined)
  } catch (toastCause) {
    logRendererError('Could not show the voice delivery error toast.', toastCause)
  }
}

/**
 * Send whatever the recording thread still holds in its composer, right now.
 * Used when the user escalates an armed dictation to "steer what I already
 * typed, and send the transcript after it".
 */
export async function sendUnsentComposerContentNow(scope: SpeechScope): Promise<void> {
  const content = unsentComposerContent(scope)
  if (!content) return
  try {
    await dispatchUnsentContent(scope, content, true)
  } catch (cause) {
    reportVoiceDeliveryFailure('The queued message could not be steered.', cause)
  }
}

/**
 * Deliver a transcript that landed while its composer was not mounted, so the
 * message reaches the thread even though the user is somewhere else entirely.
 * Resolves with the text the thread received, or null when nothing was handed
 * over, so the caller can still feed dictation-correction learning exactly like
 * the composer's own send path does.
 */
export async function deliverTranscriptHeadless(
  scope: SpeechScope,
  direct: boolean
): Promise<string | null> {
  const content = unsentComposerContent(scope)
  if (!content) return null
  try {
    return await dispatchUnsentContent(scope, content, direct)
  } catch (cause) {
    reportVoiceDeliveryFailure('The voice message could not be sent.', cause)
    return null
  }
}
