import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())
const sidebar = vi.hoisted(() => ({
  contextSidebarState: {
    sidebarVisible: true,
    sidebarActiveTab: null as { id: string } | null
  }
}))

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))
vi.mock('$lib/stores/context-sidebar.svelte', () => sidebar)

type VisibilityState = (typeof import('$lib/stores/browser-visibility.svelte'))['browserVisibility']

const TAB = 'browser:tab-one'
const OTHER_TAB = 'browser:tab-two'

/**
 * A fresh store per case.
 *
 * The module holds the one app-wide owner, and a claim that outlives a test would
 * leak into the next one: re-evaluating the module is what makes each case start
 * from no surface displaying anything.
 */
async function freshState(): Promise<VisibilityState> {
  vi.resetModules()
  const module = await import('$lib/stores/browser-visibility.svelte')
  return module.browserVisibility
}

describe('browser view claims', () => {
  beforeEach(() => {
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)
    sidebar.contextSidebarState.sidebarVisible = true
    sidebar.contextSidebarState.sidebarActiveTab = { id: TAB }
  })

  it('parks a page once the last surface showing it lets go', async () => {
    const visibility = await freshState()
    const release = visibility.claimTab(TAB, 'sidebar')

    release()
    visibility.detachReleasedTab(TAB)

    expect(invoke).toHaveBeenCalledWith('browser:hide', TAB)
  })

  it('keeps the page when another surface is still showing the same tab', async () => {
    const visibility = await freshState()
    const releaseSidebar = visibility.claimTab(TAB, 'sidebar')
    const releaseFullscreen = visibility.claimTab(TAB, 'fullscreen')

    releaseSidebar()
    visibility.detachReleasedTab(TAB)
    expect(invoke).not.toHaveBeenCalled()

    releaseFullscreen()
    visibility.detachReleasedTab(TAB)
    expect(invoke).toHaveBeenCalledWith('browser:hide', TAB)
  })

  it('keeps the page while a second copy of the same surface shows it', async () => {
    const visibility = await freshState()
    const releaseFirstSidebar = visibility.claimTab(TAB, 'sidebar')
    const releaseSecondSidebar = visibility.claimTab(TAB, 'sidebar')

    releaseFirstSidebar()
    visibility.detachReleasedTab(TAB)
    expect(invoke).not.toHaveBeenCalled()

    releaseSecondSidebar()
    visibility.detachReleasedTab(TAB)
    expect(invoke).toHaveBeenCalledWith('browser:hide', TAB)
  })

  it('does not park the page a higher surface took over', async () => {
    const visibility = await freshState()
    visibility.claimTab(TAB, 'sidebar')
    const releaseFullscreen = visibility.claimTab(TAB, 'fullscreen')

    visibility.detachUnlessAnotherSurfaceDisplays(TAB, 'sidebar')
    expect(invoke).not.toHaveBeenCalled()

    // A page nothing shows any more still parks, which is what a modal opening
    // over the browser asks for.
    releaseFullscreen()
    visibility.detachUnlessAnotherSurfaceDisplays(TAB, 'sidebar')
    expect(invoke).toHaveBeenCalledWith('browser:hide', TAB)
  })

  it('hands the view back to the surface that still displays the tab', async () => {
    const visibility = await freshState()
    const releaseSidebar = visibility.claimTab(TAB, 'sidebar')
    const releaseFullscreen = visibility.claimTab(TAB, 'fullscreen')

    // Both surfaces show the same tab, so the full screen dialog owns the view.
    expect(visibility.ownsSurface(TAB, 'fullscreen')).toBe(true)
    expect(visibility.hideReasonFor(TAB, { x: 0, y: 0, width: 800, height: 600 })).toBeNull()

    // The sidebar copy unmounting must not drop the claim the dialog relies on:
    // the page stays owned, with nothing to re-show it otherwise.
    releaseSidebar()
    expect(visibility.ownsSurface(TAB, 'fullscreen')).toBe(true)
    expect(visibility.hideReasonFor(TAB, { x: 0, y: 0, width: 800, height: 600 })).toBeNull()

    releaseFullscreen()
    expect(visibility.ownsSurface(TAB, 'fullscreen')).toBe(false)
    expect(visibility.hideReasonFor(TAB, { x: 0, y: 0, width: 800, height: 600 })).toBe(
      'not-placed'
    )
  })

  it('resolves the sidebar owner from the tab it still displays', async () => {
    const visibility = await freshState()
    const release = visibility.claimTab(TAB, 'sidebar')
    const releaseOther = visibility.claimTab(OTHER_TAB, 'sidebar')
    // The sidebar region follows its active tab, which is the one just opened.
    sidebar.contextSidebarState.sidebarActiveTab = { id: OTHER_TAB }

    // The newest claim is the tab the sidebar is showing, exactly as a switch
    // hands the view from one tab to the next.
    expect(visibility.ownsSurface(TAB, 'sidebar')).toBe(false)
    expect(visibility.ownsSurface(OTHER_TAB, 'sidebar')).toBe(true)

    releaseOther()
    sidebar.contextSidebarState.sidebarActiveTab = { id: TAB }
    expect(visibility.ownsSurface(TAB, 'sidebar')).toBe(true)
    release()
  })
})
