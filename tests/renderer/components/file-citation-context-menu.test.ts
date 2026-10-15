// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte'
import FileCitationContextMenu from '$lib/components/markdown/FileCitationContextMenu.svelte'

/**
 * The menu keeps an async resolution only while it still holds the exact target
 * the resolution began from. A deep `$state` proxy broke that identity check,
 * so `resolved` never landed and the Copy path and reveal actions rendered
 * disabled even though the file existed. These tests open the real menu and
 * assert the actions are enabled, and that no action removed by request comes
 * back.
 */

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('$lib/ipc.svelte', () => ({ invoke: bridge.invoke }))
vi.mock('$lib/copy-text', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }))
vi.mock('$lib/stores/app-errors.svelte', () => ({ reportError: vi.fn() }))
vi.mock('$lib/reveal-file', () => ({ revealCitationFile: vi.fn() }))
vi.mock('$lib/os-file-manager', () => ({
  osFileManagerLabel: () => 'Reveal in Finder',
  revealInOsFileManager: vi.fn().mockResolvedValue(true)
}))
vi.mock('$lib/stores/editor-preference.svelte', () => ({
  editorPreference: {
    load: vi.fn().mockResolvedValue(undefined),
    availableEditors: [],
    preferredInfo: undefined
  }
}))
vi.mock('$lib/stores/workspace.svelte', () => ({
  workspaceState: {
    activeProject: { id: 'proj-1' },
    activeScopeBucketIdFor: () => 'default'
  }
}))

const PROJECT_ID = 'proj-1'
const CITATION_PATH = 'src/example.ts'

let instance: ReturnType<typeof mount> | undefined

/** Every channel the resolver calls, answering the way main does for an entry
 *  that exists inside the project root. */
function resolveInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (channel === 'projectFiles:resolveCitationPaths') {
    const candidates = args[1] as string[]
    return Promise.resolve(
      Object.fromEntries(candidates.map((candidate) => [candidate, candidate]))
    )
  }
  if (channel === 'projectFiles:info') {
    const relativePath = args[1] as string
    return Promise.resolve({
      name: 'example.ts',
      path: relativePath,
      kind: 'file',
      absolutePath: `/abs/${relativePath}`
    })
  }
  return Promise.resolve(null)
}

async function openMenu(): Promise<void> {
  const target = document.createElement('div')
  document.body.append(target)
  const children = createRawSnippet(() => ({
    render: () => '<button data-test-target>cite</button>'
  }))
  instance = mount(FileCitationContextMenu, {
    target,
    props: { projectId: PROJECT_ID, citation: { path: CITATION_PATH }, children }
  })
  flushSync()

  const button = target.querySelector('[data-test-target]')
  if (!(button instanceof HTMLElement)) throw new Error('The wrapped child did not render')
  button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }))
  flushSync()

  // The resolver is async, and its result only lands while the menu still holds
  // the target it began from. Waiting for Copy path to leave the disabled state
  // is the regression guard: when the identity check fails, this never settles
  // and the wait times out with the item still disabled.
  await vi.waitFor(() => {
    expect(itemWithText('Copy path')?.getAttribute('aria-disabled')).toBe('false')
  })
  await tick()
  flushSync()
}

function menuItems(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

function itemWithText(text: string): HTMLElement | undefined {
  return menuItems().find((item) => (item.textContent ?? '').includes(text))
}

beforeEach(() => {
  bridge.invoke.mockReset()
  bridge.invoke.mockImplementation(resolveInvoke)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 10, 10)
  )
})

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('FileCitationContextMenu', () => {
  it('enables Copy path and the file-manager reveal for a resolvable attachment', async () => {
    await openMenu()

    const copyPath = itemWithText('Copy path')
    expect(copyPath).toBeDefined()
    expect(copyPath?.getAttribute('aria-disabled')).toBe('false')

    const reveal = itemWithText('Reveal in Finder')
    expect(reveal).toBeDefined()
    expect(reveal?.getAttribute('aria-disabled')).toBe('false')
  })

  it('offers Open file, Open with, Copy path and the file-manager reveal only', async () => {
    await openMenu()

    const labels = menuItems().map((item) => (item.textContent ?? '').trim())
    expect(labels).toContain('Open file')
    expect(labels.some((label) => label.startsWith('Open with'))).toBe(true)
    expect(labels).toContain('Copy path')
    expect(labels.some((label) => label.includes('Reveal in Finder'))).toBe(true)

    const menu = labels.join('\n')
    expect(menu).not.toContain('Copy file contents')
    expect(menu).not.toContain('Save as')
    expect(menu).not.toContain('Open in ')
  })
})
