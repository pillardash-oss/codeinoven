/// <reference types="node" />

import { stat } from 'fs/promises'
import { basename } from 'path'
import { fileURLToPath } from 'url'
import type { PromptAttachment } from '../../lib/types'

/** Resolve and verify a local attachment, or retain a remote/data URL verbatim. */
export async function attachmentTarget(attachment: PromptAttachment): Promise<string> {
  if (/^(?:data:|https?:\/\/)/u.test(attachment.url)) return attachment.url
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(`Attachment path is invalid: ${attachment.filename ?? attachment.url}`)
  }
  try {
    const details = await stat(path)
    if (!details.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Attachment is not a readable file: ${attachment.filename ?? basename(path)}`)
  }
  return path
}

/** Prompt fallback for harness protocols without a native arbitrary-file block. */
export async function attachmentReference(attachment: PromptAttachment): Promise<string> {
  const target = await attachmentTarget(attachment)
  const name = attachment.filename ?? (target.startsWith('data:') ? 'attachment' : basename(target))
  return [
    `Attached file: ${name}`,
    `MIME type: ${attachment.mime}`,
    `Location: ${target}`,
    'Treat this file as part of the user prompt. Use your file-reading tools when needed.'
  ].join('\n')
}

export async function attachmentReferences(attachments: PromptAttachment[]): Promise<string> {
  return (
    await Promise.all(
      attachments.map(
        async (attachment) => `[attachment]\n${await attachmentReference(attachment)}`
      )
    )
  ).join('\n\n')
}
