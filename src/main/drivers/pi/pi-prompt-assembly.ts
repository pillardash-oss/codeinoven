import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'url'
import type { PromptAttachment } from '../../../lib/types'
import type { SendPromptOptions } from '../driver.interface'
import { inlineSvgAttachments, isSvgAttachment } from '../svg-attachment'
import { materializeAttachment } from '../attachment-data-url'

/** Materializes prompt attachments for a Pi turn. */

interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

async function localAttachmentPath(attachment: PromptAttachment): Promise<string> {
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(
      `Pi attachment is not a valid local file: ${attachment.filename ?? attachment.url}`
    )
  }
  return path
}

interface ComposedPiAttachments {
  inlineSvg: string
  images: PiImageContent[]
  references: string[]
}

/**
 * Materialize attachments for a pi turn. Images are sent both as inline base64
 * blocks (for vision-capable models) and as a path text reference   when a
 * provider or text-only model registration drops the image block, the model
 * still knows where the file lives and can read it with its file tools.
 *
 * A `data:` payload or a remote `http(s)` source is staged as a real file in
 * `scratchDirectory` first, because pi's prompt only carries local files: the
 * composer read such an attachment as a filesystem path and the turn died with
 * ENOENT before anything reached the model.
 */
async function composePiAttachments(
  attachments: SendPromptOptions['attachments'],
  scratchDirectory?: string
): Promise<ComposedPiAttachments> {
  const inlineSvg = await inlineSvgAttachments(attachments)
  const images: PiImageContent[] = []
  const references: string[] = []
  for (const attachment of attachments) {
    if (isSvgAttachment(attachment)) continue
    const staged =
      scratchDirectory === undefined
        ? attachment
        : await materializeAttachment(attachment, scratchDirectory)
    const path = await localAttachmentPath(staged)
    if (staged.mime.toLowerCase().startsWith('image/')) {
      images.push({
        type: 'image',
        data: (await readFile(path)).toString('base64'),
        mimeType: staged.mime
      })
      references.push(`Attached image file: ${path}`)
    } else {
      references.push(`Attached file: ${path}`)
    }
  }
  return { inlineSvg, images, references }
}

export { composePiAttachments }
