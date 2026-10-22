import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WINDOWS_OVEN_EXECUTABLE,
  prepareOvenExecutable
} from '../../../src/main/ovens/remote/oven-windows-executable'

describe('oven executable naming', () => {
  it('names the process after this app, not after the shared runtime', () => {
    expect(WINDOWS_OVEN_EXECUTABLE).toBe('codeinoven-oven connect.exe')
  })

  it('names the runtime on Windows and keeps its original path elsewhere', async () => {
    const scratch = join(process.cwd(), '.cio', 'tmp')
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'oven-executable-'))
    const nodePath = process.execPath
    try {
      const expected = process.platform === 'win32' ? join(root, WINDOWS_OVEN_EXECUTABLE) : nodePath
      await expect(prepareOvenExecutable(nodePath, root)).resolves.toBe(expected)
      expect((await stat(expected)).size).toBe((await stat(nodePath)).size)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
