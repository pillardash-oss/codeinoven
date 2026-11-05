import type { PromptAttachment } from '../../../lib/types'
import { attachmentTarget } from '../attachment-reference'
import {
  acpArray,
  acpRecord,
  acpString,
  type AcpContentBlock,
  type AcpPromptCapabilities
} from './acp-protocol'

/** Whether the agent accepts binary prompt blocks, from its initialize result. */
export type { AcpPromptCapabilities }

export const NO_PROMPT_CAPABILITIES: AcpPromptCapabilities = {
  image: false,
  audio: false,
  embeddedContext: false
}

interface ParsedAttachment {
  mime: string
  data: string
}

/** Split a `data:` URL into its mime type and base64 payload. */
function parseDataUrl(url: string): ParsedAttachment | null {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(url)
  if (!match) return null
  const mime = match[1]
  const data = match[2]
  if (!mime || !data) return null
  return { mime, data }
}

/**
 * Compose the `prompt` array for `session/prompt`.
 *
 * Text is the prompt itself plus one reference line per attachment, which every
 * agent understands. Binary blocks are only sent when the agent advertised the
 * matching capability, so an agent without image support never receives a block
 * it would reject.
 */
export async function acpPromptBlocks(
  text: string,
  attachments: readonly PromptAttachment[],
  capabilities: AcpPromptCapabilities
): Promise<AcpContentBlock[]> {
  const references: string[] = []
  const binaries: AcpContentBlock[] = []
  for (const attachment of attachments) {
    const target = await attachmentTarget(attachment)
    references.push(`${attachment.filename ?? attachment.mime}: ${target}`)
    if (capabilities.image && attachment.mime.startsWith('image/')) {
      const parsed = parseDataUrl(attachment.url)
      if (parsed) binaries.push({ type: 'image', data: parsed.data, mimeType: parsed.mime })
    } else if (capabilities.audio && attachment.mime.startsWith('audio/')) {
      const parsed = parseDataUrl(attachment.url)
      if (parsed) binaries.push({ type: 'audio', data: parsed.data, mimeType: parsed.mime })
    }
  }
  const body = references.length > 0 ? `${text}\n\nAttached:\n${references.join('\n')}` : text
  return [{ type: 'text', text: body }, ...binaries]
}

/** The plain text of one content block, or an empty string when it carries none. */
export function acpBlockText(block: unknown): string {
  const record = acpRecord(block)
  if (!record) return ''
  const type = acpString(record['type'])
  if (type === 'text') return acpString(record['text']) ?? ''
  if (type === 'resource') {
    const resource = acpRecord(record['resource'])
    return acpString(resource?.['text']) ?? ''
  }
  if (type === 'resource_link') {
    const name = acpString(record['name']) ?? ''
    const uri = acpString(record['uri']) ?? ''
    return name && uri ? `${name} (${uri})` : uri || name
  }
  return ''
}

/** Join the text of a block list (a streamed chunk usually holds exactly one). */
export function acpBlocksText(blocks: unknown): string {
  return acpArray(blocks)
    .map((block) => acpBlockText(block))
    .filter((text) => text.length > 0)
    .join('')
}
