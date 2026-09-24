import { describe, expect, it } from 'vitest'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, type Thread } from '$shared/types'
import {
  contentThreadFamily,
  contentViewFamily,
  decideContentViewThread,
  type ContentThreadFamily,
  type ContentViewThreadLookup
} from '$lib/content-view-threads'

function thread(id: string, projectId: string): Thread {
  return {
    id,
    projectId,
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp'
  }
}

const projectThread = thread('p1', 'project-1')
const otherProjectThread = thread('p2', 'project-2')
const chatThread = thread('c1', INBOX_PROJECT_ID)
const assistantTask = thread('a1', ASSISTANT_SPACE_ID)

function lookup(
  remembered: Partial<Record<ContentThreadFamily, Thread>> = {},
  recent: Partial<Record<ContentThreadFamily, Thread>> = {}
): ContentViewThreadLookup {
  return {
    remembered: (family) => remembered[family] ?? null,
    recentOfFamily: (family) => recent[family] ?? null
  }
}

describe('contentThreadFamily', () => {
  it('maps each container to its own family', () => {
    expect(contentThreadFamily(projectThread)).toBe('projects')
    expect(contentThreadFamily(chatThread)).toBe('chats')
    expect(contentThreadFamily(assistantTask)).toBe('assistant')
  })
})

describe('contentViewFamily', () => {
  it('treats Projects and Threads as one family', () => {
    expect(contentViewFamily('projects')).toBe('projects')
    expect(contentViewFamily('projects-scope')).toBe('projects')
    expect(contentViewFamily('threads')).toBe('projects')
  })

  it('gives Chats and Assistant their own family', () => {
    expect(contentViewFamily('chats')).toBe('chats')
    expect(contentViewFamily('assistant')).toBe('assistant')
  })

  it('leaves takeover views without a family', () => {
    expect(contentViewFamily('scope')).toBeNull()
    expect(contentViewFamily('settings')).toBeNull()
    expect(contentViewFamily('settings-memory')).toBeNull()
  })
})

describe('decideContentViewThread', () => {
  it('keeps the open thread when it belongs to the view', () => {
    expect(decideContentViewThread('projects', projectThread, lookup())).toEqual({ kind: 'keep' })
    expect(decideContentViewThread('threads', projectThread, lookup())).toEqual({ kind: 'keep' })
    expect(decideContentViewThread('chats', chatThread, lookup())).toEqual({ kind: 'keep' })
    expect(decideContentViewThread('assistant', assistantTask, lookup())).toEqual({ kind: 'keep' })
  })

  it('never keeps a thread of another family', () => {
    expect(decideContentViewThread('projects', chatThread, lookup())).toEqual({ kind: 'clear' })
    expect(decideContentViewThread('chats', projectThread, lookup())).toEqual({ kind: 'clear' })
    expect(decideContentViewThread('assistant', projectThread, lookup())).toEqual({ kind: 'clear' })
  })

  it('restores the assistant task when leaving Projects for Assistant', () => {
    expect(
      decideContentViewThread('assistant', projectThread, lookup({ assistant: assistantTask }))
    ).toEqual({ kind: 'open', thread: assistantTask })
  })

  it('restores the project thread when leaving Assistant for Projects', () => {
    expect(
      decideContentViewThread('projects', assistantTask, lookup({ projects: projectThread }))
    ).toEqual({ kind: 'open', thread: projectThread })
  })

  it('restores the chat when leaving Assistant for Chats, and back', () => {
    expect(decideContentViewThread('chats', assistantTask, lookup({ chats: chatThread }))).toEqual({
      kind: 'open',
      thread: chatThread
    })
    expect(
      decideContentViewThread('assistant', chatThread, lookup({ assistant: assistantTask }))
    ).toEqual({ kind: 'open', thread: assistantTask })
  })

  it('falls back to the family most recent thread when nothing is remembered', () => {
    expect(
      decideContentViewThread('assistant', projectThread, lookup({}, { assistant: assistantTask }))
    ).toEqual({ kind: 'open', thread: assistantTask })
    expect(
      decideContentViewThread('projects', assistantTask, lookup({}, { projects: projectThread }))
    ).toEqual({ kind: 'open', thread: projectThread })
  })

  it('prefers the remembered thread over the most recent one', () => {
    expect(
      decideContentViewThread(
        'projects',
        assistantTask,
        lookup({ projects: projectThread }, { projects: otherProjectThread })
      )
    ).toEqual({ kind: 'open', thread: projectThread })
  })

  it('clears the selection when the target family has no thread at all', () => {
    expect(decideContentViewThread('assistant', projectThread, lookup())).toEqual({ kind: 'clear' })
    expect(decideContentViewThread('projects', null, lookup())).toEqual({ kind: 'clear' })
  })

  it('leaves takeover views untouched', () => {
    expect(decideContentViewThread('scope', projectThread, lookup())).toEqual({ kind: 'keep' })
    expect(decideContentViewThread('settings-memory', null, lookup())).toEqual({ kind: 'keep' })
  })
})
