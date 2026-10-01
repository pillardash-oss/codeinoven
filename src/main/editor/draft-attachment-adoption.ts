import { join } from 'path'
import { mkdir, readdir, rename } from 'fs/promises'
import { getConfigRoot } from '../../lib/utils'
import { PROJECT_DATA_DIRECTORY, chatThreadWorkspaceDirectory } from '../../lib/project-artifacts'
import { DRAFT_CHAT_THREAD_ID } from '../../lib/types'

/**
 * Adopt what the welcome composer staged before its chat existed.
 *
 * That composer has no thread while the draft is only a draft, so it stages
 * attachments into a transient scope; the moment the chat exists, everything in
 * that scope belongs to the chat and is moved into the chat's own scratch path
 * (`chats-cwd/<threadId>/.cio/tmp/attachments`). The moves are answered so the
 * composer can repoint the attachment chips it still holds at the files' new
 * homes.
 *
 * A partial failure rolls the moves already made back, so a draft is never left
 * split across two directories by a move that stopped halfway.
 */
export async function adoptDraftAttachments(
  threadId: string
): Promise<Array<{ from: string; to: string }>> {
  const source = draftAttachmentDirectory()
  let entries: string[]
  try {
    entries = await readdir(source)
  } catch {
    // Nothing was staged, which is the common case: a draft with no files.
    return []
  }
  if (entries.length === 0) return []

  const destination = join(
    getConfigRoot(),
    chatThreadWorkspaceDirectory(threadId),
    PROJECT_DATA_DIRECTORY,
    'tmp',
    'attachments'
  )
  await mkdir(destination, { recursive: true })

  const adopted: Array<{ from: string; to: string }> = []
  try {
    for (const entry of entries) {
      const from = join(source, entry)
      const to = join(destination, entry)
      await rename(from, to)
      adopted.push({ from, to })
    }
  } catch (error) {
    for (const move of adopted.reverse()) {
      await rename(move.to, move.from).catch(() => undefined)
    }
    throw error
  }
  return adopted
}

/** The transient attachments directory the welcome composer stages into. */
function draftAttachmentDirectory(): string {
  return join(
    getConfigRoot(),
    chatThreadWorkspaceDirectory(DRAFT_CHAT_THREAD_ID),
    PROJECT_DATA_DIRECTORY,
    'tmp',
    'attachments'
  )
}
