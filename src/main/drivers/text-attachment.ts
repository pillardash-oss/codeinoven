/// <reference types="node" />

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../logger'
import type { PromptAttachment } from '../../lib/types'

const TEXT_MIME_PREFIX = 'text/'

const TEXT_LIKE_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/csv',
  'application/x-csv',
  'application/graphql',
  'application/x-python'
])

const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'font/']

const BINARY_MIMES = new Set([
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])

/** Filename extension → fenced-code language hint (empty means no fence hint). */
const TEXT_EXTENSION_LANGUAGE = new Map<string, string>([
  ['json', 'json'],
  ['jsonc', 'jsonc'],
  ['jsonl', 'jsonl'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['sql', 'sql'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['jsx', 'jsx'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['svelte', 'svelte'],
  ['vue', 'vue'],
  ['txt', 'text'],
  ['log', 'text'],
  ['ini', 'ini'],
  ['cfg', 'ini'],
  ['conf', 'text'],
  ['properties', 'properties'],
  ['env', ''],
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile']
])

function attachmentExtension(attachment: PromptAttachment): string {
  const filename = (attachment.filename ?? attachment.url).toLowerCase()
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1) : filename
}

/**
 * True when an attachment carries text content that harnesses only accept as
 * file parts, which some providers reject by media type. Inlining such
 * attachments as text avoids that failure without changing what the model sees.
 */
export function isTextAttachment(attachment: PromptAttachment): boolean {
  const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
  if (mime.startsWith(TEXT_MIME_PREFIX) || TEXT_LIKE_MIMES.has(mime)) return true
  if (mime) {
    if (BINARY_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return false
    if (BINARY_MIMES.has(mime)) return false
  }
  return TEXT_EXTENSION_LANGUAGE.has(attachmentExtension(attachment))
}

/**
 * Read a text attachment's raw content. Returns null when the attachment is not
 * text-ish or its source cannot be read, so callers fall back to normal file
 * handling instead of failing the turn.
 */
export async function readTextAttachment(attachment: PromptAttachment): Promise<string | null> {
  if (!isTextAttachment(attachment)) return null
  try {
    if (attachment.url.startsWith('file:')) {
      return await readFile(fileURLToPath(attachment.url), 'utf8')
    }
    if (attachment.url.startsWith('data:')) {
      const separator = attachment.url.indexOf(',')
      if (separator < 0) return null
      const metadata = attachment.url.slice(0, separator)
      const payload = attachment.url.slice(separator + 1)
      if (!payload) return null
      return metadata.endsWith(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload)
    }
  } catch (error) {
    Logger.error(`Failed to read text attachment ${attachment.filename ?? attachment.url}:`, error)
  }
  return null
}

/** Label used when a text attachment's source is inlined as text. */
function textAttachmentLabel(attachment: PromptAttachment): string {
  return attachment.filename ?? attachment.url
}

/** Wrap one text attachment's raw content in a short, model-friendly text block. */
export function formatTextAsText(attachment: PromptAttachment, content: string): string {
  const language = TEXT_EXTENSION_LANGUAGE.get(attachmentExtension(attachment)) ?? ''
  return `Attached text file ${textAttachmentLabel(attachment)}:\n\`\`\`${language}\n${content}\n\`\`\``
}

/**
 * Collect raw content for every text-ish attachment. Returns an empty string
 * when none of the attachments are readable text.
 */
export async function inlineTextAttachments(attachments: PromptAttachment[]): Promise<string> {
  const blocks: string[] = []
  for (const attachment of attachments) {
    if (!isTextAttachment(attachment)) continue
    const content = await readTextAttachment(attachment)
    if (content !== null) blocks.push(formatTextAsText(attachment, content))
  }
  return blocks.join('\n\n')
}
