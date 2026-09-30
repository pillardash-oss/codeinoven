import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readableRelayAttachments } from '../../src/main/chat/chat-engine/continuation-attachments'

describe('readableRelayAttachments', () => {
  let directory: string
  let existingPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codeinoven-relay-'))
    existingPath = join(directory, 'screenshot.png')
    await writeFile(existingPath, 'png-bytes')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps an attachment whose file is still on disk, by path and by file URL', async () => {
    const attachments = [
      { mime: 'image/png', url: existingPath, filename: 'screenshot.png' },
      {
        mime: 'image/png',
        url: pathToFileURL(existingPath).toString(),
        filename: 'screenshot.png'
      }
    ]
    await expect(readableRelayAttachments(attachments)).resolves.toEqual(attachments)
  })

  it('drops an attachment whose file is gone', async () => {
    const missing = { mime: 'image/png', url: join(directory, 'gone.png'), filename: 'gone.png' }
    const kept = { mime: 'image/png', url: existingPath, filename: 'screenshot.png' }
    await expect(readableRelayAttachments([missing, kept])).resolves.toEqual([kept])
  })

  it('passes a URL that names no local file through untouched', async () => {
    const remote = { mime: 'image/png', url: 'https://example.com/shot.png' }
    await expect(readableRelayAttachments([remote])).resolves.toEqual([remote])
  })

  it('answers an empty list for an empty relay', async () => {
    await expect(readableRelayAttachments([])).resolves.toEqual([])
  })
})
