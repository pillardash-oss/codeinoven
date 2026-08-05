import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../logger'
import type { PromptAttachment } from '../../lib/types'

const SVG_MIME = 'image/svg+xml'

/** True when an attachment should be sent to the harness as raw SVG markup. */
export function isSvgAttachment(attachment: PromptAttachment): boolean {
  return (
    attachment.mime.toLowerCase() === SVG_MIME ||
    (attachment.filename?.toLowerCase().endsWith('.svg') ?? false) ||
    attachment.url.toLowerCase().endsWith('.svg')
  )
}

/**
 * Read an SVG attachment's raw markup. Returns null when the attachment is not
 * an SVG or its source cannot be read, so callers fall back to normal
 * image/file handling instead of failing the turn.
 */
export async function readSvgAttachmentText(attachment: PromptAttachment): Promise<string | null> {
  if (!isSvgAttachment(attachment)) return null
  try {
    if (attachment.url.startsWith('file:')) {
      return await readFile(fileURLToPath(attachment.url), 'utf8')
    }
    if (attachment.url.startsWith('data:image/svg+xml')) {
      const payload = attachment.url.slice(attachment.url.indexOf(',') + 1)
      if (!payload) return null
      return attachment.url.includes(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload)
    }
  } catch (error) {
    Logger.error(`Failed to read SVG attachment ${attachment.filename ?? attachment.url}:`, error)
  }
  return null
}

/** Label used when an SVG's source is inlined as text. */
function svgAttachmentLabel(attachment: PromptAttachment): string {
  return attachment.filename ?? attachment.url
}

/** Wrap one SVG's raw markup in a short, model-friendly text block. */
export function formatSvgAsText(attachment: PromptAttachment, content: string): string {
  return `Attached SVG file ${svgAttachmentLabel(attachment)}:\n\`\`\`svg\n${content}\n\`\`\``
}

/**
 * Collect raw SVG markup for every SVG attachment. Returns an empty string when
 * none of the attachments are readable SVGs.
 */
export async function inlineSvgAttachments(attachments: PromptAttachment[]): Promise<string> {
  const blocks: string[] = []
  for (const attachment of attachments) {
    if (!isSvgAttachment(attachment)) continue
    const content = await readSvgAttachmentText(attachment)
    if (content !== null) blocks.push(formatSvgAsText(attachment, content))
  }
  return blocks.join('\n\n')
}
