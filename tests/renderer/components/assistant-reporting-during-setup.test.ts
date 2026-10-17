// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(async (channel: string) =>
    channel === 'utilities:list'
      ? { utilities: [] }
      : channel === 'assistant:gettingStartedCheckpoint' || channel === 'assistant:knowledgeThread'
        ? null
        : []
  )
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import AssistantPanel from '$lib/components/assistant/AssistantPanel.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import type { Assistant } from '$shared/types'

let instance: ReturnType<typeof mount> | undefined
let target: HTMLDivElement | undefined

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  target?.remove()
  assistants.assistants = []
})

describe('reporting while the assistant is still being set up', () => {
  it('shows controls before knowledge exists and updates them from pushed assistant state', () => {
    const assistant: Assistant = {
      id: 'setup-assistant',
      name: 'New assistant',
      knowledge: '',
      schedule: null,
      connections: [],
      createdAt: 1,
      updatedAt: 1
    }
    assistants.assistants = [assistant]
    target = document.createElement('div')
    document.body.append(target)
    flushSync(() => {
      instance = mount(AssistantPanel, {
        target: target!,
        props: {
          projectId: 'assistant',
          threadId: 'setup-thread',
          assistantId: assistant.id,
          panelTab: 'assistant',
          navigate: () => undefined,
          onOpenTask: () => undefined,
          onSetupConnection: () => undefined
        }
      })
    })
    expect(target.querySelector('[aria-label="Delivery channel"]')?.textContent).toContain(
      'Delivery channel'
    )
    expect(target.querySelector('[aria-label="Time-based priority"]')?.textContent).toContain(
      'Timeliness'
    )
    expect(target.querySelector('[aria-label="Scope-based priority"]')?.textContent).toContain(
      'Impact'
    )
    flushSync(() => {
      assistants.assistants = [
        {
          ...assistant,
          name: 'Judge',
          delivery: { channel: 'in-app' },
          priority: { timeliness: 'today', impact: 'company' },
          updatedAt: 2
        }
      ]
    })
    expect(target.querySelector('[aria-label="Delivery channel"]')?.textContent).toContain(
      'In-app thread'
    )
    expect(target.querySelector('[aria-label="Time-based priority"]')?.textContent).toContain(
      'Today'
    )
    expect(target.querySelector('[aria-label="Scope-based priority"]')?.textContent).toContain(
      'The company'
    )
    expect(assistants.assistants[0]?.knowledge).toBe('')
  })
})
