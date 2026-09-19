import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'url'
import type { PromptAttachment } from '../../../lib/types'
import type { SendPromptOptions } from '../driver.interface'
import { inlineSvgAttachments, isSvgAttachment } from '../svg-attachment'

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
 */
async function composePiAttachments(
  attachments: SendPromptOptions['attachments']
): Promise<ComposedPiAttachments> {
  const inlineSvg = await inlineSvgAttachments(attachments)
  const images: PiImageContent[] = []
  const references: string[] = []
  for (const attachment of attachments) {
    if (isSvgAttachment(attachment)) continue
    const path = await localAttachmentPath(attachment)
    if (attachment.mime.toLowerCase().startsWith('image/')) {
      images.push({
        type: 'image',
        data: (await readFile(path)).toString('base64'),
        mimeType: attachment.mime
      })
      references.push(`Attached image file: ${path}`)
    } else {
      references.push(`Attached file: ${path}`)
    }
  }
  return { inlineSvg, images, references }
}

export { composePiAttachments }
