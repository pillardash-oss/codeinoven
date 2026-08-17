import { describe, expect, it } from 'vitest'
import {
  RENDERER_RECOVERY_STORAGE_KEY,
  emptyRendererRecoverySnapshot,
  loadRendererRecoveryState,
  parseRendererRecoveryState,
  persistRendererRecoveryState,
  recoveryDraftKey,
  removeRendererRecoveryState,
  type RecoveryStorage
} from '$lib/stores/renderer-recovery'
import { RendererRecoveryStore } from '$lib/stores/renderer-recovery.svelte'

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
      lastContentView: 'chats',
      lastViewBeforeSettings: 'chats',
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
          ],
          promptReferences: [
            {
              id: 'selection-1',
              label: 'Selection 1',
              text: 'Revert the auth change',
              messageId: 'assistant-1',
              startOffset: 12,
              endOffset: 34
            }
          ],
          startAfterThreads: [
            { id: 'source-1', title: 'Source one' },
            { id: 'source-2', title: 'Source two' }
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
    expect(restored.lastContentView).toBe('chats')
    expect(restored.lastViewBeforeSettings).toBe('chats')
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
      ],
      promptReferences: [
        {
          id: 'selection-1',
          label: 'Selection 1',
          text: 'Revert the auth change',
          messageId: 'assistant-1',
          startOffset: 12,
          endOffset: 34
        }
      ],
      startAfterThreads: [
        { id: 'source-1', title: 'Source one' },
        { id: 'source-2', title: 'Source two' }
      ]
    })
    expect(storage.values.has(RENDERER_RECOVERY_STORAGE_KEY)).toBe(true)
  })

  it('validates untrusted stored values field by field', () => {
    const validDraftKey = JSON.stringify(['project-1', 'thread-1'])
    const parsed = parseRendererRecoveryState(
      JSON.stringify({
        version: 1,
        activeView: 'invalid',
        lastContentView: 'threads',
        lastViewBeforeSettings: 'scope',
        selectedProjectId: 42,
        selectedThread: { projectId: 'project-1', threadId: '' },
        composerDrafts: {
          [validDraftKey]: {
            text: 'kept',
            attachments: [],
            projectReferences: [],
            taskReferences: [],
            promptReferences: []
          },
          invalid: 'discarded',
          [JSON.stringify(['project-2', 'thread-2'])]: 42
        }
      })
    )

    expect(parsed.activeView).toBe('projects')
    expect(parsed.lastContentView).toBe('threads')
    expect(parsed.lastViewBeforeSettings).toBe('scope')
    expect(parsed.selectedProjectId).toBeNull()
    expect(parsed.selectedThread).toBeNull()
    expect(parsed.composerDrafts).toEqual({
      [validDraftKey]: {
        text: 'kept',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: [],
        startAfterThreads: []
      }
    })
  })

  it('persists response-selection annotations with the composer draft', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    const reference = {
      id: 'selection-1',
      label: 'Selection 1',
      text: 'Revert the auth change',
      messageId: 'assistant-1',
      startOffset: 12,
      endOffset: 34
    }

    store.setPromptReferences('project-1', 'thread-1', [reference])
    expect(store.draftPromptReferences('project-1', 'thread-1')).toEqual([reference])
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(true)

    // Survives a fresh store reading the same storage (app restart).
    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.draftPromptReferences('project-1', 'thread-1')).toEqual([reference])

    // Clearing annotations drops the whole draft entry when nothing else is present.
    store.setPromptReferences('project-1', 'thread-1', [])
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
    const cleared = new RendererRecoveryStore(storage)
    expect(cleared.draftPromptReferences('project-1', 'thread-1')).toEqual([])
  })

  it('persists multiple start-after threads and migrates the legacy single dependency', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)

    store.setStartAfterThreads('project-1', 'thread-1', [
      { id: 'source-1', title: 'Source one' },
      { id: 'source-2', title: 'Source two' }
    ])
    expect(store.startAfterThreadsFor('project-1', 'thread-1')).toEqual([
      { id: 'source-1', title: 'Source one' },
      { id: 'source-2', title: 'Source two' }
    ])
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(true)

    // A fresh store (app restart) restores the full dependency list.
    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.startAfterThreadsFor('project-1', 'thread-1')).toEqual([
      { id: 'source-1', title: 'Source one' },
      { id: 'source-2', title: 'Source two' }
    ])

    // Clearing removes the whole draft entry when nothing else is present.
    store.clearStartAfterThreads('project-1', 'thread-1')
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)

    // Legacy records (single thread under startAfterThreadId/Title) upgrade to an array.
    const legacyStorage = new MemoryStorage()
    persistRendererRecoveryState(legacyStorage, {
      version: 1,
      activeView: 'projects',
      lastContentView: 'projects',
      lastViewBeforeSettings: 'projects',
      selectedProjectId: null,
      selectedThread: null,
      composerDrafts: {
        [recoveryDraftKey('project-1', 'thread-1')]: {
          text: 'legacy',
          attachments: [],
          projectReferences: [],
          taskReferences: [],
          promptReferences: [],
          startAfterThreadId: 'source-legacy',
          startAfterThreadTitle: 'Legacy source'
        }
      },
      collapsedFolders: [],
      favoriteModels: [],
      recentModels: [],
      chatFavoriteModels: [],
      chatRecentModels: [],
      queuedMessages: {}
    })
    expect(
      new RendererRecoveryStore(legacyStorage).startAfterThreadsFor('project-1', 'thread-1')
    ).toEqual([{ id: 'source-legacy', title: 'Legacy source' }])
  })

  it('continues operating when storage access fails', () => {
    expect(() => {
      loadRendererRecoveryState(new UnavailableStorage())
      persistRendererRecoveryState(new UnavailableStorage(), emptyRendererRecoverySnapshot())
      removeRendererRecoveryState(new UnavailableStorage())
    }).not.toThrow()
  })

  it('treats distinct harness-scoped favorites as separate', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    store.favoriteModels = ['opencode:openai:gpt-5.6']

    // A different harness with the same provider+model is a distinct favorite.
    store.toggleFavorite('codex:openai:gpt-5.6')

    expect(store.favoriteModels).toEqual(['opencode:openai:gpt-5.6', 'codex:openai:gpt-5.6'])
  })
})
