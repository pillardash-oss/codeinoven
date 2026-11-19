import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { PiDriver } from '../../../src/main/drivers/pi-driver'

describe('a pi session that runs on an Oven', () => {
  it('keeps its id when it is bound to the Oven checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oven-session-path-'))
    const driver = new PiDriver(new StorageEngine(root))
    try {
      const localPath = '/Users/someone/code/client'
      const ovenPath = '/home/azureuser/.config/pillardash/codeinoven/ovens/scopes/abc/def'
      const sessionId = 'oven-c41e4716-890d-43ee-84ff-72b90765b4ba'
      await driver.adoptSessionPath(ovenPath, sessionId, 'Azure session')
      // The record hashes the Oven checkout now, which is the directory this
      // turn's harness actually runs in.
      await expect(driver.requireSession(ovenPath, sessionId)).resolves.toMatchObject({
        id: sessionId
      })
      // The local project path is no longer what this session belongs to.
      await expect(driver.requireSession(localPath, sessionId)).rejects.toThrow(
        `CLI session is unavailable: ${sessionId}`
      )
    } finally {
      driver.dispose?.()
      await rm(root, { recursive: true, force: true })
    }
  })
})
