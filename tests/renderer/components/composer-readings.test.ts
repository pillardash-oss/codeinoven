// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount, type ComponentProps } from 'svelte'
import { readingReveal } from './stubs/reading-reveal-state.svelte'

/**
 * The two readings the composer opens by command (`/status`, `/tps`).
 *
 * They cover the regression that made the battery throw
 * `effect_update_depth_exceeded`: the popover now opens from a request token and
 * only assigns its own `open`, while the owner's reveal work rides the command.
 * If that reveal ever moves back inside the popover's effect, the first test below
 * throws, because the reveal reads the state it writes.
 */
const invokeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {}),
  subscribeGuarded: vi.fn(() => () => {})
}))

// jsdom ships no ResizeObserver, which the shoe measures its own row with.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

const { default: ComposerShoeReadingHarness } =
  await import('./stubs/ComposerShoeReadingHarness.svelte')
const { default: ChatComposer } = await import('$lib/components/chats/ChatComposer.svelte')

const panel = (label: string) =>
  document.body.querySelector(`[data-popover-content][aria-label="${label}"]`) as HTMLElement | null

const BATTERY = 'Context and provider usage'
const RATE = 'Generation speed details'

/**
 * One animation frame, then the microtask queue: bits-ui keeps a closing panel
 * mounted for a frame before it unmounts it, so a settle that only drains timers
 * leaves the previous reading attached and gives the swap assertions a false
 * failure. jsdom fires the frame, and its elements have no `getAnimations`,
 * so one frame is all the exit path waits for here.
 */
async function settle(): Promise<void> {
  flushSync()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync()
}

function renderShoe(onReveal: () => void, onHide?: () => void) {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(ComposerShoeReadingHarness, { target, props: { onReveal, onHide } })
  return { target, component }
}

type ComposerProps = ComponentProps<typeof ChatComposer>

function renderComposer(props: ComposerProps) {
  const target = document.createElement('div')
  document.body.append(target)
  const component = mount(ChatComposer, { target, props })
  return { target, component }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the shoe readings a composer command opens', () => {
  it('opens the battery and reveals the reading on the command, not in an effect', async () => {
    const onReveal = vi.fn(() => readingReveal.reveal())
    const { component } = renderShoe(onReveal)
    await settle()
    expect(panel(BATTERY)).toBeNull()

    component.openReading('context')
    await settle()

    expect(panel(BATTERY)).not.toBeNull()
    expect(panel(RATE)).toBeNull()
    // Exactly one reveal, run on the user's action: this is what keeps the
    // reading's own read/write out of the popover's effect.
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(readingReveal.reveals).toBe(1)

    unmount(component)
  })

  it('replaces the battery with the generation rate', async () => {
    const onReveal = vi.fn()
    const { component } = renderShoe(onReveal)
    await settle()

    component.openReading('context')
    await settle()
    expect(panel(BATTERY)).not.toBeNull()

    component.openReading('rate')
    await settle()
    expect(panel(RATE)).not.toBeNull()
    expect(panel(BATTERY)).toBeNull()
    expect(onReveal).toHaveBeenCalledTimes(1)

    unmount(component)
  })
})

describe('typing a reading command into the composer', () => {
  it('opens the battery for /status instead of sending it', async () => {
    const onSend = vi.fn()
    const onRevealUsage = vi.fn()
    const { target, component } = renderComposer({
      onSend,
      shoe: { identity: { kind: 'chat' } },
      initialValue: '/status',
      generationRate: 42,
      onRevealUsage
    })
    await settle()

    expect(target.querySelector('[contenteditable="true"]')?.textContent).toBe('/status')
    const send = target.querySelector('[aria-label="Send message"]') as HTMLButtonElement | null
    expect(send).not.toBeNull()
    send?.click()
    await settle()

    expect(onSend).not.toHaveBeenCalled()
    expect(panel(BATTERY)).not.toBeNull()
    expect(onRevealUsage).toHaveBeenCalledTimes(1)

    unmount(component)
  })

  it('opens the generation rate for /tps instead of sending it', async () => {
    const onSend = vi.fn()
    const { target, component } = renderComposer({
      onSend,
      shoe: { identity: { kind: 'chat' } },
      initialValue: '/tps',
      generationRate: 42
    })
    await settle()

    const send = target.querySelector('[aria-label="Send message"]') as HTMLButtonElement | null
    send?.click()
    await settle()

    expect(onSend).not.toHaveBeenCalled()
    expect(panel(RATE)).not.toBeNull()
    expect(panel(BATTERY)).toBeNull()

    unmount(component)
  })
})
