import { describe, expect, it } from 'vitest'
import {
  RENDERER_RECOVERY_STORAGE_KEY,
  emptyRendererRecoverySnapshot,
  loadRendererRecoveryState,
  parseRendererRecoveryState,
  persistRendererRecoveryState,
  recoveryDraftKey,
  removeRendererRecoveryState,
  type ComposerDraftEntry,
  type RecoveryStorage
} from './renderer-recovery'

class MemoryStorage implements RecoveryStorage {
  values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class UnavailableStorage implements RecoveryStorage {
  getItem(): string | null {
    throw new Error('blocked')
  }

  setItem(): void {
    throw new Error('quota')
  }

  removeItem(): void {
    throw new Error('blocked')
  }
}

describe('RendererRecoveryStore', () => {
  it('persists navigation and per-thread drafts across loads', () => {
    const storage = new MemoryStorage()
    const draftKey = recoveryDraftKey('project-1', 'thread-1')
    persistRendererRecoveryState(storage, {
      version: 1,
      activeView: 'chats',
      selectedProjectId: 'project-1',
      selectedThread: { projectId: 'project-1', threadId: 'thread-1' },
      composerDrafts: {
        [draftKey]: {
          text: 'Continue the checkpoint work',
          attachments: [
            {
              mime: 'image/png',
              url: 'file:///tmp/test.png',
              filename: 'test.png'
            }
          ],
          projectReferences: [
            {
              id: 'project-reference-1',
              name: 'src',
              path: 'src',
              kind: 'directory'
            }
          ],
          taskReferences: [
            {
              assignmentId: 'assignment-1',
              taskId: 'task-1',
              phaseId: 'phase-1',
              title: 'Resolve the deployment blocker',
              description: 'Confirm production configuration.',
              status: 'blocked'
            }
          ]
        }
      },
      collapsedFolders: [],
      favoriteModels: [],
      recentModels: [],
      chatFavoriteModels: [],
      chatRecentModels: [],
      queuedMessages: {}
    })

    const restored = loadRendererRecoveryState(storage)
    expect(restored.activeView).toBe('chats')
    expect(restored.selectedProjectId).toBe('project-1')
    expect(restored.selectedThread).toEqual({
      projectId: 'project-1',
      threadId: 'thread-1'
    })
    expect(restored.composerDrafts[draftKey]).toEqual({
      text: 'Continue the checkpoint work',
      attachments: [
        {
          mime: 'image/png',
          url: 'file:///tmp/test.png',
          filename: 'test.png'
        }
      ],
      projectReferences: [
        {
          id: 'project-reference-1',
          name: 'src',
          path: 'src',
          kind: 'directory'
        }
      ],
      taskReferences: [
        {
          assignmentId: 'assignment-1',
          taskId: 'task-1',
          phaseId: 'phase-1',
          title: 'Resolve the deployment blocker',
          description: 'Confirm production configuration.',
          status: 'blocked'
        }
      ]
    })
    expect(storage.values.has(RENDERER_RECOVERY_STORAGE_KEY)).toBe(true)
  })

  it('migrates legacy string-only drafts to the new entry format', () => {
    const storage = new MemoryStorage()
    const draftKey = recoveryDraftKey('project-1', 'thread-1')
    persistRendererRecoveryState(storage, {
      version: 1,
      activeView: 'projects',
      selectedProjectId: null,
      selectedThread: null,
      composerDrafts: { [draftKey]: 'Legacy draft' as unknown as ComposerDraftEntry },
      collapsedFolders: [],
      favoriteModels: [],
      recentModels: [],
      chatFavoriteModels: [],
      chatRecentModels: [],
      queuedMessages: {}
    })

    const restored = loadRendererRecoveryState(storage)
    expect(restored.composerDrafts[draftKey]).toEqual({
      text: 'Legacy draft',
      attachments: [],
      projectReferences: [],
      taskReferences: []
    })
  })

  it('validates untrusted stored values field by field', () => {
    const validDraftKey = JSON.stringify(['project-1', 'thread-1'])
    const parsed = parseRendererRecoveryState(
      JSON.stringify({
        version: 1,
        activeView: 'invalid',
        selectedProjectId: 42,
        selectedThread: { projectId: 'project-1', threadId: '' },
        composerDrafts: {
          [validDraftKey]: 'kept',
          invalid: 'discarded',
          [JSON.stringify(['project-2', 'thread-2'])]: 42
        }
      })
    )

    expect(parsed.activeView).toBe('projects')
    expect(parsed.selectedProjectId).toBeNull()
    expect(parsed.selectedThread).toBeNull()
    expect(parsed.composerDrafts).toEqual({
      [validDraftKey]: {
        text: 'kept',
        attachments: [],
        projectReferences: [],
        taskReferences: []
      }
    })
  })

  it('continues operating when storage access fails', () => {
    expect(() => {
      loadRendererRecoveryState(new UnavailableStorage())
      persistRendererRecoveryState(new UnavailableStorage(), emptyRendererRecoverySnapshot())
      removeRendererRecoveryState(new UnavailableStorage())
    }).not.toThrow()
  })
})
