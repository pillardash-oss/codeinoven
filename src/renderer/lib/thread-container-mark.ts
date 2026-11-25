import type { AssistantAppearanceSource } from './assistant-icons'
import { assistantAccentColor, ASSISTANT_ICON_FALLBACK_COLOR } from './assistant-icons'
import { contentThreadFamily } from './content-view-threads'

/**
 * The mark a thread wears wherever it is named, decided by the container it
 * lives in rather than by the surface drawing it.
 *
 * A project thread wears its project's icon, so a conversation is identified by
 * the project it belongs to even after it has been attached to a message and
 * sent: the chip the composer draws and the chip the delivered message keeps are
 * the same thread, so they must wear the same mark. Only a chat has no project
 * icon to wear   the Chats inbox is a hidden container with none of its own   so
 * the conversation mark stands for it, and an assistant thread wears the mark of
 * the assistant it belongs to, falling back to the app's own assistant mark when
 * that assistant cannot be resolved.
 */
export type ThreadContainerMark =
  /** A project's or an assistant's own icon, drawn as the image it resolved to. */
  | { kind: 'image'; url: string }
  /** The assistant's default mark, tinted with its accent colour. */
  | { kind: 'assistant'; color: string }
  /** The conversation mark: a chat, or a thread whose container resolved no icon. */
  | { kind: 'chats' }

/** What the caller could resolve for one thread's container. */
export interface ThreadContainerMarkSources {
  /** The project's resolved icon (`getProjectIcon`), when it has one. */
  projectIconUrl?: string | null
  /** The assistant an assistant thread belongs to, when the caller knows it. */
  assistant?: AssistantAppearanceSource | null
  /** The assistant's resolved icon, when it has one of its own. */
  assistantIconUrl?: string | null
}

/**
 * Resolve the mark for one thread.
 *
 * The family decides first, because an assistant's own icon is not a project
 * icon: a thread in the hidden Assistant container wears its assistant even when
 * a stale project icon was handed in for the same id.
 */
export function threadContainerMark(
  container: { projectId: string },
  sources: ThreadContainerMarkSources = {}
): ThreadContainerMark {
  const family = contentThreadFamily(container)
  if (family === 'assistant') {
    if (sources.assistantIconUrl) return { kind: 'image', url: sources.assistantIconUrl }
    return {
      kind: 'assistant',
      color: sources.assistant
        ? assistantAccentColor(sources.assistant)
        : ASSISTANT_ICON_FALLBACK_COLOR
    }
  }
  if (family === 'chats') return { kind: 'chats' }
  if (sources.projectIconUrl) return { kind: 'image', url: sources.projectIconUrl }
  return { kind: 'chats' }
}
