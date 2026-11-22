import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import type { SessionInfo } from '../../src/main/chat/chat-engine/chat-engine-types'
import type { CreateThreadInput, Thread, ThreadSettings } from '../../src/lib/types'
import { removeTempRoots } from '../helpers/temp-root'

/**
 * The file-access scope a chat gets when its turn runs on an external Oven.
 *
 * The Oven hands the session its own thread root, and that root is the
 * directory the Oven's shell starts in. A chat scope that named this machine's
 * `chats-cwd/<threadId>` instead left every command unprovable there, so the
 * policy raised a card for `ls -la` in the agent's own working directory.
 */

const OVEN_ID = '85f559a8-6780-42d6-baa9-7a053d2a1565'
const OVEN_ROOT =
  '/home/azureuser/.config/pillardash/codeinoven/ovens/scopes/caadbcffec9038112a56/6e441a10540ae1fc602d'

const settings: ThreadSettings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review',
  fileSystemMode: false
}

interface EngineInternals {
  threadManager: {
    createThread(input: CreateThreadInput): Promise<Thread>
  }
}

const temporaryDatabases: Database[] = []
const temporaryRoots: string[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-permission-scope-'))
  temporaryRoots.push(temporaryConfigRoot)
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(async () => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  await removeTempRoots(temporaryRoots.splice(0))
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

async function chatScope(target: { ovenId?: string }): Promise<{
  scratchPaths: string[]
  restrictToAllowed: boolean
}> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  // The hidden container every standalone chat lives in, seeded the way
  // `ProjectManager.ensureInboxProject` seeds it at app start.
  new ProjectRepo(db).upsert({
    id: 'inbox',
    name: 'Chats',
    path: '',
    source: 'local',
    providerId: '',
    workflowId: 'default',
    threadLimit: 200,
    hidden: true,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(storage, db)
  const thread = await internals(engine).threadManager.createThread({
    projectId: 'inbox',
    providerId: 'pi',
    title: 'GTA 6 on Mac',
    workingDirectory: OVEN_ROOT,
    settings: {
      ...settings,
      ...(target.ovenId ? { ovenId: target.ovenId } : {})
    }
  })
  const info = {
    sessionId: 'session-1',
    projectId: 'inbox',
    threadId: thread.id,
    projectPath: OVEN_ROOT,
    permissionLevel: 'auto_review',
    driverId: 'pi'
  } satisfies SessionInfo
  return engine.units['permissions'].chatPermissionScope(info)
}

describe('chat permission scope on an external Oven', () => {
  it('pre-authorizes the Oven thread root the session runs in', async () => {
    const scope = await chatScope({ ovenId: OVEN_ID })

    // The Oven's own temp is that machine's scratch in exactly the way a local
    // chat's workspace is this machine's: a probe writing `/tmp/o.txt` there is
    // not reaching outside its authorisation.
    expect(scope.scratchPaths).toEqual([OVEN_ROOT, '/tmp', '/var/tmp', '/private/tmp'])
    expect(scope.restrictToAllowed).toBe(true)
  })

  it('keeps this machine’s chat workspace for a local chat', async () => {
    const scope = await chatScope({})

    expect(scope.scratchPaths.some((path) => path === OVEN_ROOT)).toBe(false)
    expect(scope.scratchPaths).toHaveLength(1)
  })
})
