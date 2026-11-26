import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => join(process.cwd(), '.cio', 'tmp') },
  ipcMain: { handle: () => undefined },
  // The engine wires the credential vault on construction; this suite never
  // reads or writes a secret, but the probe still asks whether it could.
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf-8'),
    decryptStringAsync: async (buffer: Buffer) => ({
      result: buffer.toString('utf-8'),
      shouldReEncrypt: false
    })
  }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import type {
  PendingImageDescriptorDecision,
  PendingPermissionInfo
} from '../../src/main/chat/chat-engine/chat-engine-types'
import type { ThreadSettings } from '../../src/lib/types'
import type { PermissionRequest } from '../../src/lib/types'
import type { Thread } from '../../src/lib/types'
import { removeTempRoots } from '../helpers/temp-root'

/**
 * The open aggregate.
 *
 * Opening a thread used to cost five renderer→main round trips that all re-read
 * the same thread row on the one shared database worker. `thread:openDigest`
 * answers all of them from a single row read, and these tests hold that
 * property: the row is read once, every part keeps its own channel's answer,
 * and a part that cannot be answered is named instead of failing the open.
 */

const PROJECT_ID = 'open-digest-project'

const settings: ThreadSettings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review',
  fileSystemMode: false
}

const temporaryDatabases: Database[] = []
const temporaryRoots: string[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let configRoot = ''

beforeEach(() => {
  configRoot = mkdtempSync(join(process.cwd(), '.cio', 'tmp', 'open-digest-'))
  temporaryRoots.push(configRoot)
  process.env['CODEINOVEN_CONFIG_ROOT'] = configRoot
})

afterEach(async () => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  await removeTempRoots(temporaryRoots.splice(0))
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

async function openDigestFixture(): Promise<{ engine: ChatEngine; thread: Thread }> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  // The project is the thread's only owner, so the row has to exist for the
  // thread to be readable in it.
  new ProjectRepo(db).upsert({
    id: PROJECT_ID,
    name: 'Open digest',
    path: configRoot,
    source: 'local',
    providerId: '',
    workflowId: 'default',
    threadLimit: 20,
    hidden: false,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const engine = new ChatEngine(new StorageEngine(configRoot), db)
  const thread = await engine.threadManager.createThread({
    projectId: PROJECT_ID,
    providerId: 'pi',
    title: 'Open digest',
    workingDirectory: configRoot,
    settings
  })
  return { engine, thread }
}

function permissionFor(): PermissionRequest {
  return {
    id: 'permission-1',
    sessionId: 'session-1',
    permission: 'bash',
    patterns: ['ls -la'],
    metadata: {}
  }
}

function seedPendingPermission(engine: ChatEngine, thread: Thread): PermissionRequest {
  const request = permissionFor()
  const pending: PendingPermissionInfo = {
    driverId: 'pi',
    session: {
      sessionId: request.sessionId,
      projectId: thread.projectId,
      threadId: thread.id,
      projectPath: configRoot,
      permissionLevel: 'auto_review',
      driverId: 'pi'
    },
    request,
    policy: {
      decision: 'ask',
      approved: false,
      reason: 'listed for review',
      risk: 'low',
      scope: { projectRoot: configRoot, paths: [] },
      approval: { required: true },
      ledger: {
        permission: request.permission,
        risk: 'low',
        decision: 'ask',
        reason: 'listed for review',
        scope: { projectRoot: configRoot, paths: [] }
      }
    },
    resumeStatus: 'executing'
  }
  engine.state.pendingPermissions.set(request.id, pending)
  return request
}

function seedImageDescriptorError(
  engine: ChatEngine,
  thread: Thread
): PendingImageDescriptorDecision {
  const decision: PendingImageDescriptorDecision = {
    sessionId: 'session-1',
    projectId: thread.projectId,
    threadId: thread.id,
    request: {
      id: 'image-error-1',
      sessionId: 'session-1',
      projectId: thread.projectId,
      threadId: thread.id,
      surfaceThreadId: thread.id,
      error: 'The vision model refused the image.',
      kind: 'unknown',
      partialOutput: '',
      imageCount: 1,
      createdAt: Date.now()
    },
    resolve: () => undefined,
    resumeStatus: 'executing'
  }
  engine.state.pendingImageDescriptorDecisions.set(decision.request.id, decision)
  return decision
}

describe('thread open digest', () => {
  it('answers every part of an open from one thread-row read', async () => {
    const { engine, thread } = await openDigestFixture()
    const permission = seedPendingPermission(engine, thread)
    const imageError = seedImageDescriptorError(engine, thread)
    const readRow = vi.spyOn(engine.threadManager, 'getThread')

    const digest = await engine.readOpenDigest(thread.projectId, thread.id)

    expect(digest.thread?.id).toBe(thread.id)
    expect(digest.thread?.settings?.harnessId).toBe('pi')
    expect(digest.permissions).toEqual([permission])
    expect(digest.imageDescriptorErrors).toEqual([imageError.request])
    // A thread that never ran has no provider questions and no live session
    // state, exactly as the separate channels answer for it.
    expect(digest.questions).toEqual([])
    expect(digest.sessionStatus).toBeNull()
    expect(digest.failures).toEqual([])
    // The property this aggregate exists for: one row read, shared by every
    // part, instead of one per channel.
    expect(readRow).toHaveBeenCalledTimes(1)
  })

  it('hands the row to the parts so none of them reads it again', async () => {
    const { engine, thread } = await openDigestFixture()
    const permission = seedPendingPermission(engine, thread)
    const readRow = vi.spyOn(engine.threadManager, 'getThread')
    readRow.mockClear()

    expect(
      await engine.units['permissions'].listPermissions(thread.projectId, thread.id, thread)
    ).toEqual([permission])
    expect(
      await engine.units['questions-ask'].listQuestions(thread.projectId, thread.id, thread)
    ).toEqual([])
    expect(
      await engine.units['turns-sessions'].getSessionStatus(thread.projectId, thread.id, thread)
    ).toBeNull()

    expect(readRow).not.toHaveBeenCalled()
  })

  it('keeps every individual channel reading the row itself', async () => {
    const { engine, thread } = await openDigestFixture()
    const permission = seedPendingPermission(engine, thread)

    expect(await engine.listPermissions(thread.projectId, thread.id)).toEqual([permission])
    expect(await engine.listQuestions(thread.projectId, thread.id)).toEqual([])
    expect(await engine.getSessionStatus(thread.projectId, thread.id)).toBeNull()
  })

  it('names a part that could not be answered instead of failing the open', async () => {
    const { engine, thread } = await openDigestFixture()
    const permission = seedPendingPermission(engine, thread)
    vi.spyOn(engine.units['media-artifacts'], 'listImageDescriptorErrors').mockRejectedValue(
      new Error('vision queue unavailable')
    )

    const digest = await engine.readOpenDigest(thread.projectId, thread.id)

    expect(digest.failures).toEqual(['imageDescriptorErrors'])
    // The rest of the answer is still true, so the caller re-reads only the one
    // channel that failed.
    expect(digest.thread?.id).toBe(thread.id)
    expect(digest.permissions).toEqual([permission])
    expect(digest.imageDescriptorErrors).toEqual([])
  })

  it('reports an invisible thread as a null row and empty parts', async () => {
    const { engine, thread } = await openDigestFixture()

    const digest = await engine.readOpenDigest('another-project', thread.id)

    expect(digest.thread).toBeNull()
    expect(digest.questions).toEqual([])
    expect(digest.sessionStatus).toBeNull()
    expect(digest.failures).toEqual([])
  })
})
