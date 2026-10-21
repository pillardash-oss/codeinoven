import { describe, expect, it } from 'vitest'
import {
  WINDOWS_OVEN_EXECUTABLE,
  prepareOvenExecutable
} from '../../../src/main/ovens/remote/oven-windows-executable'

describe('oven executable naming', () => {
  it('names the process after this app, not after the shared runtime', () => {
    expect(WINDOWS_OVEN_EXECUTABLE).toBe('codeinoven-oven connect.exe')
  })

  it('leaves the runtime path alone where Task Manager naming does not apply', async () => {
    // Only Windows shows a process by the path that started it, so nothing is
    // created on this machine and the caller keeps the runtime it passed in.
    const nodePath = process.execPath
    await expect(prepareOvenExecutable(nodePath, '/tmp/cio-oven-check')).resolves.toBe(nodePath)
  })
})
