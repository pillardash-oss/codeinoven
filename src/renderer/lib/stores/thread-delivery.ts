/**
 * Shared headless delivery for a thread: the small set of lookups and the send
 * path that any surface outside a mounted `ThreadView` needs to put a message
 * into a conversation.
 *
 * Two callers exist today: the queued-message dispatcher (a message queued
 * while the agent was busy) and armed voice dictation (a transcript that must
 * be sent even though its thread is not on screen). Both must agree on the
 * thread's settings, on whether its agent is genuinely idle, and on how a
 * message is actually dispatched, so those live here once.
 */
import { invoke } from '$lib/ipc.svelte'
import { messageId as createMessageId } from '$shared/id'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { CHAT_DEFAULT_SETTINGS, DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
import {
  INBOX_PROJECT_ID,
  type PromptAssignmentTaskReference,
  type PromptAttachment,
  type PromptProjectReference,
  type PromptReference,
  type Thread,
  type ThreadSettings
} from '$shared/types'

/** Everything a headless send can carry from a composer. */
export interface HeadlessThreadMessage {
  text: string
  attachments?: PromptAttachment[]
  promptContext?: string
  promptReferences?: PromptReference[]
  projectReferences?: PromptProjectReference[]
  taskReferences?: PromptAssignmentTaskReference[]
}

/** The thread's persisted settings, else the appropriate defaults. */
export async function resolveThreadDeliverySettings(
  projectId: string,
  threadId: string
): Promise<ThreadSettings> {
  try {
    const thread = await invoke('thread:get', projectId, threadId)
    if (thread?.settings) return { ...DEFAULT_SETTINGS, ...thread.settings }
  } catch {
    // Fall through to the defaults when the thread record cannot be read.
  }
  return projectId === INBOX_PROJECT_ID ? { ...CHAT_DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS }
}

/** The thread's authoritative agent state, read from the main process. */
export async function threadAgentIsIdle(projectId: string, threadId: string): Promise<boolean> {
  try {
    const status = await invoke('agent:getSessionStatus', projectId, threadId)
    if (status) return status.state === 'idle'
    const thread = await invoke('thread:get', projectId, threadId)
    return thread !== null && !['planning', 'executing'].includes(thread.status)
  } catch {
    // Be conservative when state cannot be read: treat the thread as busy so a
    // caller parks its message instead of dispatching into a live turn.
    return false
  }
}

/**
 * A user decision gate (permission, question, or image descriptor) keeps a
 * parked message parked until the user resolves it.
 */
export async function threadHasPendingGate(projectId: string, threadId: string): Promise<boolean> {
  try {
    const permissions = await invoke('agent:listPermissions', projectId, threadId)
    if (permissions.length > 0) return true
    const imageDescriptorErrors = await invoke(
      'agent:listImageDescriptorErrors',
      projectId,
      threadId
    )
    if (imageDescriptorErrors.length > 0) return true
    const questions = await invoke('agent:listQuestions', projectId, threadId)
    if (questions.length > 0) return true
  } catch {
    // Be conservative when gate state cannot be read: keep the message parked
    // and let the next idle transition (or opening the thread) retry.
    return true
  }
  return false
}

/**
 * Dispatch a message into a thread with no mounted conversation view: make sure
 * the thread has a session, then hand the text to the store's optimistic send
 * path. The chat engine steers a live turn on its own, so a dispatch that
 * lands mid-turn behaves as a steer instead of colliding with the driver.
 * Resolves with the id of the user message it appended.
 */
export async function sendThreadMessageHeadless(
  projectId: string,
  threadId: string,
  message: HeadlessThreadMessage
): Promise<string> {
  const settings = await resolveThreadDeliverySettings(projectId, threadId)
  const sessionId = await invoke('agent:ensureSession', projectId, threadId, settings.harnessId)
  if (sessionId) threadMessages.setSessionId(projectId, threadId, sessionId)
  return threadMessages.send(
    projectId,
    threadId,
    settings,
    message.text,
    message.attachments ?? [],
    undefined,
    createMessageId(),
    undefined,
    message.promptContext,
    message.promptReferences,
    message.projectReferences,
    undefined,
    message.taskReferences
  )
}

/** Whether a thread has reached a terminal state, for start-after scheduling. */
export function isTerminalThread(thread: Thread): boolean {
  return (
    thread.status === 'completed' || thread.status === 'failed' || thread.status === 'interrupted'
  )
}
