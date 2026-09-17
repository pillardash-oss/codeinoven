import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PromptAttachment } from '../../../lib/types'
import { attachmentReference } from '../attachment-reference'

/** Claude Code attachment blocks and realtime stream input encoding. */

const CLAUDE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const CLAUDE_TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-typescript'
])

type ClaudeImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

type ClaudeInputBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        { type: 'base64'; media_type: ClaudeImageMime; data: string } | { type: 'url'; url: string }
    }
  | {
      type: 'document'
      source:
        | { type: 'base64'; media_type: 'application/pdf'; data: string }
        | { type: 'text'; media_type: 'text/plain'; data: string }
        | { type: 'url'; url: string }
      title?: string
    }

function attachmentLabel(attachment: PromptAttachment): string {
  if (attachment.filename) return attachment.filename
  try {
    return basename(
      attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
    )
  } catch {
    return attachment.url
  }
}

async function attachmentBytes(attachment: PromptAttachment): Promise<Buffer> {
  if (attachment.url.startsWith('data:')) {
    const separator = attachment.url.indexOf(',')
    if (separator < 0)
      throw new Error(`Claude attachment is invalid: ${attachmentLabel(attachment)}`)
    const metadata = attachment.url.slice(0, separator)
    const payload = attachment.url.slice(separator + 1)
    return metadata.endsWith(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  }
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(`Claude attachment path is invalid: ${attachmentLabel(attachment)}`)
  }
  try {
    return await readFile(path)
  } catch {
    throw new Error(`Claude attachment is not readable: ${attachmentLabel(attachment)}`)
  }
}

export async function claudeInputBlocks(
  text: string,
  attachments: PromptAttachment[]
): Promise<ClaudeInputBlock[]> {
  const content: ClaudeInputBlock[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
    const title = attachmentLabel(attachment)
    const remote = /^https?:\/\//u.test(attachment.url)
    if (CLAUDE_IMAGE_MIMES.has(mime)) {
      content.push({
        type: 'image',
        source: remote
          ? { type: 'url', url: attachment.url }
          : {
              type: 'base64',
              media_type: mime as ClaudeImageMime,
              data: (await attachmentBytes(attachment)).toString('base64')
            }
      })
      continue
    }
    if (mime === 'application/pdf') {
      content.push({
        type: 'document',
        source: remote
          ? { type: 'url', url: attachment.url }
          : {
              type: 'base64',
              media_type: 'application/pdf',
              data: (await attachmentBytes(attachment)).toString('base64')
            },
        title
      })
      continue
    }
    if (mime.startsWith('text/') || CLAUDE_TEXT_MIMES.has(mime)) {
      if (remote) {
        throw new Error(`Claude cannot attach remote text files directly: ${title}`)
      }
      content.push({
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: (await attachmentBytes(attachment)).toString('utf8')
        },
        title
      })
      continue
    }
    content.push({ type: 'text', text: await attachmentReference(attachment) })
  }
  return content
}

export async function claudeStreamInput(
  text: string,
  attachments: PromptAttachment[],
  priority?: 'now'
): Promise<string> {
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: attachments.length > 0 ? await claudeInputBlocks(text, attachments) : text
    },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  }
  return `${JSON.stringify(message)}\n`
}
