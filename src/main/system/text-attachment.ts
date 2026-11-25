import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../../lib/utils'

/** Filename a composer text attachment gets; also what re-saving an existing one accepts. */
export const TEXT_ATTACHMENT_NAME_PATTERN = /^pasted-[0-9a-f-]+\.txt$/u

/**
 * Write `text` as a fresh composer text attachment inside `directory` and answer
 * its path.
 *
 * Shared by the pasted-text pipeline and by anything in main that already holds
 * text too long to inline into a prompt (a deployment log, for example), so a
 * long body never has to travel through IPC just to be saved. Callers own
 * registering the path as user-selected.
 */
export async function writeTextAttachment(directory: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const targetPath = join(directory, `pasted-${randomUUID()}.txt`)
  await atomicWrite(targetPath, text)
  return targetPath
}
