// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, unmount, type ComponentProps } from 'svelte'
import OvenSurfaceOverlay from '$lib/components/shared/OvenSurfaceOverlay.svelte'

/** Everything the surface accepts except its content, which the tests own. */
type OverlayProps = Omit<ComponentProps<typeof OvenSurfaceOverlay>, 'children'>

/** The surface's own content, so the tests can assert how it is presented. */
const body = createRawSnippet(() => ({
  render: () => '<span data-testid="body">checkout contents</span>'
}))

function renderOverlay(props: OverlayProps): HTMLElement {
  const target = document.createElement('div')
  document.body.append(target)
  const instance = mount(OvenSurfaceOverlay, { target, props: { children: body, ...props } })
  overlays.push({ instance, target })
  return target
}

const overlays: { instance: ReturnType<typeof mount>; target: HTMLElement }[] = []

/** The wrapper the overlay dims, i.e. the parent of the surface's own content. */
function contentWrapper(target: HTMLElement): HTMLElement {
  const node = target.querySelector('[data-testid="body"]')?.parentElement
  if (!node) throw new Error('The surface content was not rendered')
  return node
}

describe('Oven surface overlay', () => {
  it('dims the last-known content and says it is reading, while a read is in flight', () => {
    const target = renderOverlay({
      active: true,
      loading: true,
      showingCached: true,
      loadingLabel: 'Reading files from the Oven…'
    })
    expect(contentWrapper(target).className).toContain('grayscale')
    expect(contentWrapper(target).className).toContain('pointer-events-none')
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      'Reading files from the Oven…'
    )
  })

  it('leaves a live read alone when there is nothing cached to dim', () => {
    const target = renderOverlay({ active: true, loading: true, showingCached: false })
    expect(contentWrapper(target).className).not.toContain('grayscale')
    expect(target.querySelector('[role="status"]')).not.toBeNull()
  })

  it('shows the reason and a working retry when the Oven does not answer', () => {
    const onRetry = vi.fn()
    const target = renderOverlay({
      active: true,
      error: 'SSH connection failed (255). Check authentication and trust this host.',
      title: 'Files could not be read from the Oven',
      onRetry
    })
    const alert = target.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Files could not be read from the Oven')
    expect(alert?.textContent).toContain('SSH connection failed (255)')
    const retry = [...target.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Try again'
    )
    expect(retry).toBeDefined()
    retry?.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps the cached content dimmed behind the failure', () => {
    const target = renderOverlay({
      active: true,
      error: 'The Oven did not respond before the connection timeout.',
      showingCached: true
    })
    expect(contentWrapper(target).className).toContain('grayscale')
    expect(target.querySelector('[data-testid="body"]')).not.toBeNull()
  })

  it('stays out of the way entirely for a surface that reads this computer', () => {
    const target = renderOverlay({
      active: false,
      loading: true,
      showingCached: true,
      error: 'this must never be shown'
    })
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(target.querySelector('[role="status"]')).toBeNull()
    expect(contentWrapper(target).className).not.toContain('grayscale')
  })

  it('shows no layer once the live answer is on screen', () => {
    const target = renderOverlay({
      active: true,
      loading: false,
      showingCached: false,
      error: null
    })
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(target.querySelector('[role="status"]')).toBeNull()
  })
})

afterEach(() => {
  for (const { instance, target } of overlays.splice(0)) {
    unmount(instance)
    target.remove()
  }
})
