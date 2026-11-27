import { describe, expect, it, vi } from 'vitest'
import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference,
  PromptReference
} from '../../../src/lib/types'
import {
  mergeHeldSteerPayload,
  mergeHeldSteerText,
  type HeldSteerPayload
} from '../../../src/main/chat/chat-engine/chat-engine-held-steer-merge'
import type { ChatEngine } from '../../../src/main/chat/chat-engine'
import type { HeldSteer } from '../../../src/main/chat/chat-engine/chat-engine-types'
import { ChatEngineTurnsSteer } from '../../../src/main/chat/chat-engine/chat-engine-turns-steer'

function payload(overrides: Partial<HeldSteerPayload> = {}): HeldSteerPayload {
  return {
    text: '',
    attachments: [],
    promptReferences: [],
    projectReferences: [],
    taskReferences: [],
    ...overrides
  }
}

function reference(id: string): PromptReference {
  return { id, label: id, text: `excerpt ${id}` }
}

function fileAttachment(url: string): PromptAttachment {
  return { mime: 'image/png', url, filename: `${url.split('/').pop() ?? url}.png` }
}

describe('mergeHeldSteerText', () => {
  it('keeps both messages on separate lines', () => {
    expect(mergeHeldSteerText('first steer', 'second steer')).toBe('first steer\nsecond steer')
  })

  it('never leaves a blank line for a message with no words', () => {
    expect(mergeHeldSteerText('', 'second steer')).toBe('second steer')
    expect(mergeHeldSteerText('first steer', '   ')).toBe('first steer')
  })
})

describe('mergeHeldSteerPayload', () => {
  it('folds a second steer into the first, keeping the earlier words first', () => {
    const merged = mergeHeldSteerPayload(
      payload({ text: 'Why is the category image broken' }),
      payload({ text: 'Preview images 404 from R2' })
    )
    expect(merged.text).toBe('Why is the category image broken\nPreview images 404 from R2')
  })

  it('carries every attachment and reference exactly once', () => {
    const attachments: PromptAttachment[] = [fileAttachment('https://r2.test/a.png')]
    const references: PromptReference[] = [reference('ref-1')]
    const projectReferences: PromptProjectReference[] = [
      { id: 'file-1', name: 'a.ts', path: 'src/a.ts', kind: 'file' }
    ]
    const taskReferences: PromptAssignmentTaskReference[] = [
      {
        assignmentId: 'assignment-1',
        taskId: 'task-1',
        phaseId: 'phase-1',
        title: 'Fix previews',
        description: 'Fix the broken previews',
        status: 'ready'
      }
    ]
    const merged = mergeHeldSteerPayload(payload({ text: 'first' }), {
      ...payload({ text: 'second' }),
      attachments,
      promptReferences: references,
      projectReferences,
      taskReferences
    })
    const again = mergeHeldSteerPayload(
      { ...merged, text: 'first' },
      {
        ...payload({ text: 'second' }),
        attachments,
        promptReferences: references,
        projectReferences,
        taskReferences
      }
    )
    expect(again.attachments).toHaveLength(1)
    expect(again.promptReferences).toEqual(references)
    expect(again.projectReferences).toEqual(projectReferences)
    expect(again.taskReferences).toEqual(taskReferences)
  })

  it('keeps the displayed words and the harness prompt apart', () => {
    const merged = mergeHeldSteerPayload(
      payload({ text: 'Explain', promptText: 'Explain this function in detail' }),
      payload({ text: 'And this one', promptText: 'And this other function too' })
    )
    expect(merged.text).toBe('Explain\nAnd this one')
    expect(merged.promptText).toBe('Explain this function in detail\nAnd this other function too')
  })
})

interface MergeFakeHost {
  state: { heldSteers: Map<string, HeldSteer> }
  broadcast: (event: { type: string }) => void
}

function fakeHost(steer: HeldSteer): {
  host: MergeFakeHost
  discard: ReturnType<typeof vi.fn>
  broadcasts: { type: string }[]
} {
  const discard = vi.fn(async () => undefined)
  const broadcasts: { type: string }[] = []
  const host: MergeFakeHost = {
    state: { heldSteers: new Map([['session-1', { ...steer, discard }]]) },
    broadcast: (event) => {
      broadcasts.push(event)
    }
  }
  return { host, discard, broadcasts }
}

function heldSteer(overrides: Partial<HeldSteer> = {}): HeldSteer {
  return {
    projectId: 'project-1',
    conversationId: 'thread-1',
    userMessageId: 'message-1',
    kind: 'thread',
    payload: payload({ text: 'first steer' }),
    deliverMidTurn: async () => undefined,
    deliverAfterTurn: async () => undefined,
    discard: async () => undefined,
    ...overrides
  }
}

describe('takeHeldSteerForMerge', () => {
  it('removes the earlier row and hands its payload back to fold in', async () => {
    const { host, discard, broadcasts } = fakeHost(heldSteer())
    const unit = new ChatEngineTurnsSteer(host as unknown as ChatEngine)

    const folded = await unit.takeHeldSteerForMerge('session-1', {
      projectId: 'project-1',
      conversationId: 'thread-1',
      kind: 'thread'
    })

    expect(folded?.text).toBe('first steer')
    expect(host.state.heldSteers.size).toBe(0)
    expect(discard).toHaveBeenCalledTimes(1)
    expect(broadcasts).toEqual([
      { type: 'steer.discarded', sessionId: 'session-1', userMessageId: 'message-1' }
    ])
  })

  it('leaves a steer held for another conversation untouched', async () => {
    const { host, discard } = fakeHost(heldSteer())
    const unit = new ChatEngineTurnsSteer(host as unknown as ChatEngine)

    const folded = await unit.takeHeldSteerForMerge('session-1', {
      projectId: 'project-1',
      conversationId: 'thread-2',
      kind: 'thread'
    })

    expect(folded).toBeNull()
    expect(host.state.heldSteers.size).toBe(1)
    expect(discard).not.toHaveBeenCalled()
  })
})
