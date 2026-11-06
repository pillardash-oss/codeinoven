// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import type { TaskManagerSnapshot } from '$shared/types'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn()
}))

vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: () => () => {}
}))

vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { hideWhile: () => () => {} }
}))

vi.mock('$lib/stores/app-quit.svelte', () => ({
  appQuitState: { quitting: false }
}))

vi.mock('$lib/stores/scope.svelte', () => ({
  scopeState: { projects: [] }
}))

vi.mock('$lib/stores/workspace.svelte', () => ({
  workspaceState: { openThreadInOwningView: vi.fn() }
}))

vi.mock('$lib/stores/context-sidebar.svelte', () => ({
  contextSidebarState: {
    openBrowserForContext: vi.fn(),
    openNewTerminal: vi.fn()
  }
}))

vi.mock('$lib/system/renderer-logger', () => ({
  logRendererError: vi.fn(),
  logRendererDev: vi.fn()
}))

// jsdom implements neither of the two browser APIs the canonical modal reaches
// for: a projection observes its panel's size, and the primary-action lookup asks
// whether a candidate is really visible.
if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })
}

if (typeof HTMLElement.prototype.checkVisibility !== 'function') {
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    writable: true,
    configurable: true,
    value: (): boolean => true
  })
}

// Svelte's transitions animate through the Web Animations API, which jsdom does
// not implement: without this the panel's intro transition throws mid-mount and
// the modal renders empty.
if (typeof Element.prototype.animate !== 'function') {
  Object.defineProperty(Element.prototype, 'animate', {
    writable: true,
    configurable: true,
    value: () => ({
      cancel() {},
      onfinish: null,
      effect: null,
      currentTime: 0,
      playState: 'finished'
    })
  })
}

import TaskManagerModal from '$lib/components/workspace/TaskManagerModal.svelte'

const SNAPSHOT: TaskManagerSnapshot = {
  processes: [
    {
      pid: 4242,
      parentPid: 1,
      command: '/usr/local/bin/node vite',
      cwd: '/Users/someone/Development/demo',
      projectId: 'project-1',
      threadId: 'thread-1',
      ports: [5173],
      cpuPercent: 3.5,
      memoryBytes: 240 * 1024 * 1024,
      projectName: 'Demo',
      threadTitle: 'Build the preview',
      startedAt: 1_000,
      scope: 'thread'
    },
    {
      pid: 99,
      parentPid: 1,
      command: '/Applications/CodeInOven.app/Contents/MacOS/CodeInOven',
      cwd: null,
      projectId: null,
      threadId: null,
      ports: [],
      cpuPercent: 1,
      memoryBytes: 120 * 1024 * 1024,
      startedAt: 1_000,
      scope: 'app'
    }
  ],
  services: [],
  power: { source: 'ac', thermalState: 'nominal' },
  sampledAt: 2_000
}

const mounted: ReturnType<typeof mount>[] = []

function render(open = true) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 900, 600)
  )
  const target = document.createElement('div')
  document.body.append(target)
  const instance = mount(TaskManagerModal, {
    target,
    props: { open, onClose: () => {} }
  })
  mounted.push(instance)
  flushSync()
}

beforeEach(() => {
  bridge.invoke.mockReset()
  bridge.invoke.mockImplementation((channel: string) => {
    if (channel === 'taskManager:list') return Promise.resolve(SNAPSHOT)
    if (channel === 'project:list') return Promise.resolve([])
    return Promise.resolve(null)
  })
})

afterEach(() => {
  for (const instance of mounted.splice(0)) unmount(instance)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('task manager modal', () => {
  it('lists the running processes it was given', async () => {
    render()
    // The dialog is portalled into the document, so its rows are read there.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Demo')
    })
    expect(document.body.textContent).toContain('4242')
    expect(document.body.textContent).toContain('Build the preview')
  })
})
