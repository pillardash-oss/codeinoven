import type { AgentMessage } from '$shared/types'
import { toolChangePaths } from './components/threads/tool-diff'

/** Maximum characters of transcript sent to a temporary chat as anchor
 *  context. Larger threads are truncated from the front — the file-change
 *  index below is appended after truncation so it is never cut. */
const MAX_TRANSCRIPT_CHARS = 80_000

/** Build the parent-thread recap a temporary (read-only) chat is anchored on:
 *  the visible transcript plus an index of every file the thread's tool calls
 *  touched, so the temp agent knows where the real work happened even when the
 *  transcript itself only carries prose. */
export function temporaryChatContext(
  messages: readonly AgentMessage[],
  textOf: (message: AgentMessage) => string
): string {
  const transcript = messages
    .map((message) => {
      const text = textOf(message).trim()
      return text ? `${message.role.toUpperCase()}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(-MAX_TRANSCRIPT_CHARS)

  const changedPaths = [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === 'tool' ? toolChangePaths(part) : []))
      )
    )
  ]
  const fileIndex =
    changedPaths.length > 0
      ? `\n\nFILES CHANGED IN THIS THREAD (read them to ground specifics):\n${changedPaths
          .map((path) => `- ${path}`)
          .join('\n')}`
      : ''

  return `${transcript}${fileIndex}`
}
