import { promises as fs } from 'fs'
import { basename } from 'path'
import { fileURLToPath } from 'url'
import type { PromptAttachment } from '../../../lib/types'
import { CODEX_QUESTION_INSTRUCTION } from './codex-tools'

/** Codex prompt composition and local attachment resolution. */

export function composePrompt(systemPrompt: string | undefined, text: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${text}` : text
}

export function codexDeveloperInstructions(systemPrompt: string | undefined): string {
  return [systemPrompt?.trim(), CODEX_QUESTION_INSTRUCTION].filter(Boolean).join('\n\n')
}

export async function localAttachmentPath(attachment: PromptAttachment): Promise<string> {
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(
      `Codex attachment is not a valid local file: ${attachment.filename ?? attachment.url}`
    )
  }
  try {
    const stats = await fs.stat(path)
    if (!stats.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(
      `Codex attachment is not a readable local file: ${attachment.filename ?? basename(path)}`
    )
  }
  return path
}
