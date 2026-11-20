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
          ],
          threadReferences: []
        }
      },
      collapsedFolders: [],
      favoriteModels: [],
      recentModels: [],
      chatFavoriteModels: [],
      chatRecentModels: [],
      assistantFavoriteModels: [],
      assistantRecentModels: [],
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
      ],
      threadReferences: []
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
        startAfterThreads: [],
        threadReferences: []
      }
    })
  })

  it('writes a queued message to storage immediately, without the debounce', () => {
    // A queued message can be the only durable copy of words the database
    // never saw. The trailing debounce could lose it to a crash or force-quit
    // between park and flush, which is exactly the restart that ate a user's
    // message: no timer advances here, so the write must already have happened.
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    store.setQueuedMessage('project-1', 'thread-1', {
      text: 'the words that must survive a force-quit',
      attachments: [],
      promptContext: undefined,
      promptReferences: [],
      projectReferences: [],
      presentation: undefined,
      taskReferences: [],
      startAfterThreads: []
    })
    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.queuedMessageFor('project-1', 'thread-1')?.text).toBe(
      'the words that must survive a force-quit'
    )
  })

  it('writes a cleared queue immediately, so a crash cannot resurrect a sent message', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    store.setQueuedMessage('project-1', 'thread-1', {
      text: 'about to be delivered',
      attachments: [],
      promptContext: undefined,
      promptReferences: [],
      projectReferences: [],
      presentation: undefined,
      taskReferences: [],
      startAfterThreads: []
    })
    store.clearQueuedMessage('project-1', 'thread-1')
    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.queuedMessageFor('project-1', 'thread-1')).toBeNull()
  })

  it('keeps the design page a comment belongs to across a restart', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    const reference = {
      id: 'design-marker-1',
      kind: 'design' as const,
      label: 'Design element 1',
      text: 'Design element: div#otp',
      selector: 'div#otp',
      tabId: 'browser:agent:one',
      directory: '.cio/designs/authorize-device',
      designEntry: 'index.html',
      designId: '.cio/designs/authorize-device\u0000index.html'
    }

    store.setPromptReferences('project-1', 'thread-1', [reference])
    store.flushPersist()

    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.draftPromptReferences('project-1', 'thread-1')).toEqual([reference])
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
    store.flushPersist()
    expect(store.draftPromptReferences('project-1', 'thread-1')).toEqual([reference])
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(true)

    // Survives a fresh store reading the same storage (app restart).
    const reloaded = new RendererRecoveryStore(storage)
    expect(reloaded.draftPromptReferences('project-1', 'thread-1')).toEqual([reference])

    // Clearing annotations drops the whole draft entry when nothing else is present.
    store.setPromptReferences('project-1', 'thread-1', [])
    store.flushPersist()
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
    const cleared = new RendererRecoveryStore(storage)
    expect(cleared.draftPromptReferences('project-1', 'thread-1')).toEqual([])
  })

  it('persists multiple start-after threads', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)

    store.setStartAfterThreads('project-1', 'thread-1', [
      { id: 'source-1', title: 'Source one' },
      { id: 'source-2', title: 'Source two' }
    ])
    store.flushPersist()
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
    store.flushPersist()
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
  })

  it('queues messages FIFO per thread and dequeues the head on delivery', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)

    const first = {
      text: 'First step',
      attachments: [],
      promptReferences: [],
      projectReferences: [],
      taskReferences: [],
      startAfterThreads: []
    }
    const second = {
      text: 'Second step',
      attachments: [],
      promptReferences: [],
      projectReferences: [],
      taskReferences: [],
      startAfterThreads: []
    }

    // Two messages queued while the agent is busy   both persist, in order.
    store.setQueuedMessage('project-1', 'thread-1', first)
    store.setQueuedMessage('project-1', 'thread-1', second)
    store.flushPersist()
    expect(store.queuedMessageCount('project-1', 'thread-1')).toBe(2)
    expect(store.queuedMessageFor('project-1', 'thread-1')?.text).toBe('First step')
    expect(store.queuedMessagesFor('project-1', 'thread-1').map((entry) => entry.text)).toEqual([
      'First step',
      'Second step'
    ])

    // Delivery dequeues exactly one (the head)   the second stays queued.
    store.clearQueuedMessage('project-1', 'thread-1')
    expect(store.queuedMessageFor('project-1', 'thread-1')?.text).toBe('Second step')

    // Dequeueing the last message drops the thread's queue entry entirely.
    store.clearQueuedMessage('project-1', 'thread-1')
    expect(store.queuedMessageFor('project-1', 'thread-1')).toBeNull()
    expect(store.queuedMessageThreads()).toEqual([])
  })

  it('updates the queued head in place without touching later messages', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    store.setQueuedMessage('project-1', 'thread-1', {
      text: 'First',
      attachments: [],
      promptReferences: [],
      projectReferences: [],
      taskReferences: [],
      startAfterThreads: []
    })
    store.setQueuedMessage('project-1', 'thread-1', {
      text: 'Second',
      attachments: [],
      promptReferences: [],
      projectReferences: [],
      taskReferences: [],
      startAfterThreads: []
    })

    store.updateQueuedHead('project-1', 'thread-1', {
      text: 'First',
      attachments: [],
      promptReferences: [],
      projectReferences: [],
      taskReferences: [],
      startAfterThreads: [{ id: 'source-1', title: 'Source one' }]
    })
    expect(store.queuedMessagesFor('project-1', 'thread-1').map((entry) => entry.text)).toEqual([
      'First',
      'Second'
    ])
    expect(store.queuedMessageFor('project-1', 'thread-1')?.startAfterThreads).toEqual([
      { id: 'source-1', title: 'Source one' }
    ])
  })

  it('delete-all clears every queued message for a thread', () => {
    const storage = new MemoryStorage()
    const store = new RendererRecoveryStore(storage)
    for (const text of ['One', 'Two', 'Three']) {
      store.setQueuedMessage('project-1', 'thread-1', {
        text,
        attachments: [],
        promptReferences: [],
        projectReferences: [],
        taskReferences: [],
        startAfterThreads: []
      })
    }
    store.clearAllQueuedMessages('project-1', 'thread-1')
    expect(store.queuedMessageCount('project-1', 'thread-1')).toBe(0)
    expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
  })

  it('parses legacy single-object queues and FIFO arrays from storage', () => {
    const legacyKey = JSON.stringify(['project-1', 'thread-1'])
    const fifoKey = JSON.stringify(['project-1', 'thread-2'])
    const parsed = parseRendererRecoveryState(
      JSON.stringify({
        version: 1,
        // Pre-FIFO snapshot: one object per thread.
        queuedMessages: {
          [legacyKey]: {
            text: 'Legacy queued',
            attachments: [],
            projectReferences: [],
            taskReferences: [],
            promptReferences: []
          },
          // FIFO snapshot: an array of entries.
          [fifoKey]: [
            {
              text: 'One',
              attachments: [],
              projectReferences: [],
              taskReferences: [],
              promptReferences: []
            },
            {
              text: 'Two',
              attachments: [],
              projectReferences: [],
              taskReferences: [],
              promptReferences: []
            },
            {
              text: '',
              attachments: [],
              projectReferences: [],
              taskReferences: [],
              promptReferences: []
            }
          ]
        }
      })
    )

    expect(parsed.queuedMessages[legacyKey]?.map((entry) => entry.text)).toEqual(['Legacy queued'])
    // Empty-text entries are dropped field by field.
    expect(parsed.queuedMessages[fifoKey]?.map((entry) => entry.text)).toEqual(['One', 'Two'])
  })

  it('continues operating when storage access fails', () => {
    expect(() => {
      loadRendererRecoveryState(new UnavailableStorage())
      persistRendererRecoveryState(new UnavailableStorage(), emptyRendererRecoverySnapshot())
      removeRendererRecoveryState(new UnavailableStorage())
    }).not.toThrow()
  })

  /**
   * A composer annotation is the one piece of composer state the user creates in
   * a single deliberate action, and a refresh used to be able to swallow it.
   * These pin the round trip: annotation -> local storage -> new store -> the
   * same annotation, including the shape `don` had (no text, one annotation).
   */
  describe('composer annotations across a refresh', () => {
    const annotation = {
      id: 'selection-1',
      label: 'Selection 1',
      text: 'A passage the user selected',
      messageId: 'assistant-1',
      startOffset: 10,
      endOffset: 40,
      comment: 'This should auto reject'
    }

    it('keeps an annotation on a draft that also holds text', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setDraft('project-1', 'thread-1', 'Draft words')
      store.setPromptReferences('project-1', 'thread-1', [annotation])
      store.flushPersist()

      const reloaded = new RendererRecoveryStore(storage)
      expect(reloaded.draftFor('project-1', 'thread-1')).toBe('Draft words')
      expect(reloaded.draftPromptReferences('project-1', 'thread-1')).toHaveLength(1)
      expect(reloaded.draftPromptReferences('project-1', 'thread-1')[0]?.comment).toBe(
        'This should auto reject'
      )
    })

    it('keeps an annotation on a draft that holds nothing else', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setPromptReferences('project-1', 'don', [annotation])
      store.flushPersist()

      const reloaded = new RendererRecoveryStore(storage)
      expect(reloaded.draftFor('project-1', 'don')).toBe('')
      expect(reloaded.draftPromptReferences('project-1', 'don')).toHaveLength(1)
    })

    it('adopts the annotation the shared slot holds when its own mirror lost it', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      // The composer holds the words, but its mirror of the annotations is gone.
      store.setDraft('project-1', 'don', 'Words the user typed')
      store.flushPersist()

      const slot = JSON.stringify({
        text: 'Words the user typed',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: [annotation],
        startAfterThreads: [],
        threadReferences: []
      })
      const reloaded = new RendererRecoveryStore(storage)
      reloaded.applyCommittedDraft('project-1', 'don', slot)

      expect(reloaded.draftFor('project-1', 'don')).toBe('Words the user typed')
      expect(reloaded.draftPromptReferences('project-1', 'don')).toHaveLength(1)
    })

    it('never lets the slot replace an annotation the composer already shows', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setPromptReferences('project-1', 'thread-1', [annotation])
      store.applyCommittedDraft(
        'project-1',
        'thread-1',
        JSON.stringify({
          text: '',
          attachments: [],
          projectReferences: [],
          taskReferences: [],
          promptReferences: [],
          startAfterThreads: [],
          threadReferences: []
        })
      )
      expect(store.draftPromptReferences('project-1', 'thread-1')).toHaveLength(1)
    })

    it('keeps an annotation when the draft is re-written by the composer', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setPromptReferences('project-1', 'thread-1', [annotation])
      // What the composer does on the next keystroke: text only, no references.
      store.setDraft('project-1', 'thread-1', 'Next words')
      store.flushPersist()

      const reloaded = new RendererRecoveryStore(storage)
      expect(reloaded.draftPromptReferences('project-1', 'thread-1')).toHaveLength(1)
    })
  })

  /**
   * A draft is a cache of what the composer is about to send, and the thread row
   * is the only place that says whether it still exists. These pin the two
   * clearing rules: a send clears the slot everywhere, and a window never
   * restores a draft the row no longer carries.
   */
  describe('the shared slot clears a ghost draft', () => {
    const draftWithAnnotation = (text: string): string =>
      JSON.stringify({
        text,
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: [{ id: 'selection-1', label: 'Selection 1', text: 'Passage' }],
        startAfterThreads: [],
        threadReferences: []
      })

    it('clears the local draft the moment a message is sent', () => {
      const store = new RendererRecoveryStore(new MemoryStorage())
      store.setDraft('project-1', 'thread-1', 'Send me')
      store.setPromptReferences('project-1', 'thread-1', [
        { id: 'selection-1', label: 'Selection 1', text: 'Passage' }
      ])
      expect(store.hasDraftContent('project-1', 'thread-1')).toBe(true)

      store.clearSentDraft('project-1', 'thread-1')

      expect(store.draftFor('project-1', 'thread-1')).toBe('')
      expect(store.draftPromptReferences('project-1', 'thread-1')).toHaveLength(0)
      expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
    })

    it('drops a stored draft whose row no longer holds one', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setDraft('project-1', 'thread-1', 'Already sent elsewhere')
      store.flushPersist()

      const reloaded = new RendererRecoveryStore(storage)
      // The row answers with nothing, so the draft was sent or cleared.
      reloaded.reconcileDraftWithSlot('project-1', 'thread-1', null)

      expect(reloaded.draftFor('project-1', 'thread-1')).toBe('')
      expect(reloaded.hasDraftContent('project-1', 'thread-1')).toBe(false)
      reloaded.flushPersist()
      expect(new RendererRecoveryStore(storage).draftFor('project-1', 'thread-1')).toBe('')
    })

    it('keeps the draft the row still holds', () => {
      const store = new RendererRecoveryStore(new MemoryStorage())
      store.setDraft('project-1', 'thread-1', 'Still drafting')

      store.reconcileDraftWithSlot('project-1', 'thread-1', draftWithAnnotation('Still drafting'))

      expect(store.draftFor('project-1', 'thread-1')).toBe('Still drafting')
      expect(store.draftPromptReferences('project-1', 'thread-1')).toHaveLength(1)
    })

    it('keeps a draft whose own commit the row is still owed', () => {
      const store = new RendererRecoveryStore(new MemoryStorage())
      // Typing arms the debounced commit, so the row is behind these words.
      store.setDraft('project-1', 'thread-1', 'Typed a second ago')

      store.reconcileDraftWithSlot('project-1', 'thread-1', null)

      expect(store.draftFor('project-1', 'thread-1')).toBe('Typed a second ago')
    })

    it('clears the composer cache when the last attachment is removed', () => {
      const storage = new MemoryStorage()
      const store = new RendererRecoveryStore(storage)
      store.setDraft('project-1', 'thread-1', '', [
        { mime: 'image/png', url: 'file:///tmp/a.png', filename: 'a.png' }
      ])
      expect(store.hasDraftContent('project-1', 'thread-1')).toBe(true)

      store.setDraft('project-1', 'thread-1', '', [])
      store.flushPersist()

      expect(store.hasDraftContent('project-1', 'thread-1')).toBe(false)
      expect(new RendererRecoveryStore(storage).hasDraftContent('project-1', 'thread-1')).toBe(
        false
      )
    })
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
