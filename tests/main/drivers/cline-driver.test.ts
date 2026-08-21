import { EventEmitter } from 'events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import type { AgentEvent } from '../../../src/lib/types'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { ClineDriver } from '../../../src/main/drivers/cline-driver'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>()
  return { ...original, spawn: spawnMock }
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: vi.fn(() => true),
    end: vi.fn()
  }
  killed = false
  emitPayload(payload: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`))
  }
  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

const roots: string[] = []
afterEach(async () => {
  spawnMock.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-cline-driver-'))
  roots.push(root)
  const value = new StorageEngine(root)
  await value.initialize()
  return value
}

const settings = {
  harnessId: 'cline',
  providerId: 'cline',
  modelId: 'poolside/laguna-s-2.1:free',
  thinkingLevel: 'medium' as const,
  permissionLevel: 'auto_review' as const,
  engineeringMode: false
}

describe.skipIf(process.platform === 'win32')('ClineDriver approval bridge', () => {
  it('runs headless turns in-process and auto-approves tools via the app policy', async () => {
    const driver = new ClineDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Cline')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'compose a PR', attachments: [] })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args, spawnOptions] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv }
    ]
    expect(args).toContain('--json')
    expect(spawnOptions.env?.['CLINE_SESSION_BACKEND_MODE']).toBe('local')
    expect(spawnOptions.env?.['CLINE_TOOL_APPROVAL_MODE']).toBe('desktop')
    const approvalDir = spawnOptions.env?.['CLINE_TOOL_APPROVAL_DIR']
    expect(approvalDir).toBeTruthy()

    await mkdir(approvalDir!, { recursive: true })
    // Cline writes a request file and waits for a matching decision file.
    await writeFile(
      join(approvalDir!, 'native-1.request.run-commands.json'),
      JSON.stringify({
        requestId: 'run-commands',
        sessionId: 'native-1',
        toolName: 'run_commands',
        input: { commands: 'git fetch origin' }
      }),
      'utf8'
    )
    await vi.waitFor(async () => {
      const decision = await readFile(
        join(approvalDir!, 'native-1.decision.run-commands.json'),
        'utf8'
      )
      return expect(JSON.parse(decision)).toMatchObject({ approved: true })
    })

    // A destructive command is denied by the app's PermissionPolicy.
    await writeFile(
      join(approvalDir!, 'native-1.request.rm.json'),
      JSON.stringify({
        requestId: 'rm',
        sessionId: 'native-1',
        toolName: 'run_commands',
        input: { commands: 'rm -rf /tmp/example' }
      }),
      'utf8'
    )
    await vi.waitFor(async () => {
      const decision = await readFile(join(approvalDir!, 'native-1.decision.rm.json'), 'utf8')
      return expect(JSON.parse(decision)).toMatchObject({ approved: false })
    })

    // The turn is aborted by killing the local backend process.
    await driver.abort('/project', sessionId)
    expect(child.killed).toBe(true)
  })

  it('denies non-read tools for read-only turns', async () => {
    const driver = new ClineDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Cline')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'explain',
      attachments: [],
      readOnly: true
    })
    const [, , spawnOptions] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv }
    ]
    const approvalDir = spawnOptions.env?.['CLINE_TOOL_APPROVAL_DIR']
    expect(approvalDir).toBeTruthy()
    await mkdir(approvalDir!, { recursive: true })
    await writeFile(
      join(approvalDir!, 'native-1.request.write.json'),
      JSON.stringify({
        requestId: 'write',
        sessionId: 'native-1',
        toolName: 'write_file',
        input: { file_path: '/project/out.txt' }
      }),
      'utf8'
    )
    await vi.waitFor(async () => {
      const decision = await readFile(join(approvalDir!, 'native-1.decision.write.json'), 'utf8')
      return expect(JSON.parse(decision)).toMatchObject({ approved: false })
    })
  })

  it('skips the approval bridge for full_access turns', async () => {
    const driver = new ClineDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Cline')
    await driver.sendPrompt('/project', {
      sessionId,
      settings: { ...settings, permissionLevel: 'full_access' },
      text: 'go',
      attachments: []
    })
    const [, args, spawnOptions] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv }
    ]
    expect(spawnOptions.env?.['CLINE_SESSION_BACKEND_MODE']).toBe('local')
    expect(spawnOptions.env?.['CLINE_TOOL_APPROVAL_MODE']).toBeUndefined()
    expect(spawnOptions.env?.['CLINE_TOOL_APPROVAL_DIR']).toBeUndefined()
    expect(args).toContain('--auto-approve')
    expect(args[args.indexOf('--auto-approve') + 1]).toBe('true')
  })
})
