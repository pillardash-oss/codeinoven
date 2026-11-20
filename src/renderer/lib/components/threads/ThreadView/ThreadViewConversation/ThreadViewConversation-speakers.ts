/**
 * Who a group thread signs a reply with.
 *
 * An ordinary thread has exactly one implied assistant author, so it never needs
 * this. A group thread holds several assistants, and a reply that does not say
 * who spoke is unattributable, so the transcript resolves a speaker for every
 * reply it draws, including a live one that has no message row yet.
 */

import { assistants } from '$lib/stores/assistants.svelte'
import { assistantAccentColor, getAssistantIcon } from '$lib/assistant-icons'
import { assistantIsDon } from '$shared/types'
import type { AgentMessage, Thread } from '$shared/types'

/** One assistant a group thread's transcript names above its reply. */
export interface GroupSpeaker {
  name: string
  icon: string | null
  color: string
  /** Whether this speaker owns a plate, so its mark is drawn the way its tile is. */
  plate: boolean
}

/**
 * The assistant that spoke one reply in a group thread, or null when there is
 * nobody left to name.
 *
 * The message's own `author` snapshot wins, because it is what the reply read as
 * when it was written: an assistant can be renamed, re-iconed or deleted after it
 * spoke, and the conversation that happened must keep reading as itself. A reply
 * with no snapshot is the thread's own assistant speaking (the host of a group
 * opens the conversation as itself), so it is resolved through the assistants the
 * renderer already holds rather than through a second path.
 *
 * The icon comes from `getAssistantIcon`, the same resolution every assistant
 * surface uses, with the stored image icon by id as its highest priority.
 */
export function groupSpeakerFor(thread: Thread, msg: AgentMessage): GroupSpeaker | null {
  const author = msg.author
  if (author) {
    return {
      name: author.name,
      icon: getAssistantIcon(author, assistants.iconUrls.get(author.assistantId) ?? null),
      color: assistantAccentColor(author),
      plate: assistantIsDon({ id: author.assistantId })
    }
  }
  return groupSpeakerForThread(thread)
}

/** The speaker of this thread's own replies, when the thread runs as one
 *  assistant. Used before any message exists, so a live reply can open with the
 *  name it will answer under. */
export function groupSpeakerForThread(thread: Thread): GroupSpeaker | null {
  const assistant = assistants.assistantForTask(thread)
  if (!assistant) return null
  return {
    name: assistant.name,
    icon: getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null),
    color: assistantAccentColor(assistant),
    plate: assistantIsDon(assistant)
  }
}
