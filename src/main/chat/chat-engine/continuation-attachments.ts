import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PromptAttachment } from '../../../lib/types'

/** Materializes the attachments a continuation relay is allowed to carry. */

/**
 * Keep only the attachments a relayed request can still materialize.
 *
 * A relay re-sends a request the user made earlier, and the files it carried
 * can be gone from disk by the time the retry runs: a screenshot the user
 * cleaned up, a scratch copy the system removed, an attachment that only ever
 * lived on another machine. A vanished file drops from the relay rather than
 * failing the turn the user is waiting on   the relay still carries the
 * request text, and the caller records what was left out.
 *
 * Only local paths and `file:` URLs are probed; any other URL belongs to the
 * driver's own attachment handling and passes through untouched.
 */
export async function readableRelayAttachments(
  attachments: readonly PromptAttachment[]
): Promise<PromptAttachment[]> {
  const readable: PromptAttachment[] = []
  for (const attachment of attachments) {
    const isFileUrl = attachment.url.startsWith('file:')
    if (!isFileUrl && !isAbsolute(attachment.url)) {
      readable.push(attachment)
      continue
    }
    try {
      const path = isFileUrl ? fileURLToPath(attachment.url) : attachment.url
      await access(path, constants.R_OK)
      readable.push(attachment)
    } catch {
      // Gone from disk, or not a usable file URL: the relay goes without it.
    }
  }
  return readable
}
