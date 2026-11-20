import { describe, expect, it } from 'vitest'
import {
  createHostUiContext,
  type HostUiRequest,
  type HostUiResponse
} from '../../src/main/drivers/pi/session-host/ui-context'

function harness(): {
  context: ReturnType<typeof createHostUiContext>
  requests: HostUiRequest[]
  notifications: HostUiRequest[]
  answer: (response: HostUiResponse) => void
} {
  const requests: HostUiRequest[] = []
  const notifications: HostUiRequest[] = []
  let pending: ((response: HostUiResponse) => void) | null = null
  const context = createHostUiContext({
    ask: (request) => {
      requests.push(request)
      return new Promise<HostUiResponse>((resolve) => {
        pending = resolve
      })
    },
    notify: (request) => notifications.push(request)
  })
  return {
    context,
    requests,
    notifications,
    answer: (response) => {
      const resolve = pending
      pending = null
      resolve?.(response)
    }
  }
}

describe('createHostUiContext', () => {
  it('asks the app for a selection and returns its value', async () => {
    const { context, requests, answer } = harness()
    const chosen = context.select('Pick one', ['a', 'b'], { timeout: 1_000 })
    expect(requests[0]).toMatchObject({
      method: 'select',
      title: 'Pick one',
      options: ['a', 'b'],
      timeout: 1_000
    })
    answer({ value: 'b' })
    await expect(chosen).resolves.toBe('b')
  })

  it('treats a cancelled or timed out dialog as no answer', async () => {
    const { context, answer } = harness()
    const chosen = context.select('Pick one', ['a'])
    answer({ cancelled: true })
    await expect(chosen).resolves.toBeUndefined()

    const confirmed = context.confirm('Sure?', 'Really sure?')
    answer({ cancelled: true })
    await expect(confirmed).resolves.toBe(false)

    const typed = context.input('Name', 'placeholder')
    answer({ cancelled: true })
    await expect(typed).resolves.toBeUndefined()
  })

  it('returns a confirmation as a boolean', async () => {
    const { context, requests, answer } = harness()
    const confirmed = context.confirm('Allow write?', 'The agent wants to write a file')
    expect(requests[0]).toMatchObject({
      method: 'confirm',
      title: 'Allow write?',
      message: 'The agent wants to write a file'
    })
    answer({ confirmed: true })
    await expect(confirmed).resolves.toBe(true)
  })

  it('gives every dialog its own id so answers cannot cross', async () => {
    const { context, requests } = harness()
    void context.select('one', ['a'])
    void context.select('two', ['b'])
    expect(requests).toHaveLength(2)
    expect(requests[0].id).not.toBe(requests[1].id)
  })

  it('prefixes every request id with the session so two hosts cannot collide', () => {
    const requests: string[] = []
    const first = createHostUiContext(
      { ask: (request) => (requests.push(request.id), new Promise(() => undefined)), notify: () => undefined },
      { idPrefix: 'sess-a' }
    )
    const second = createHostUiContext(
      { ask: (request) => (requests.push(request.id), new Promise(() => undefined)), notify: () => undefined },
      { idPrefix: 'sess-b' }
    )
    void first.confirm('a', 'a')
    void second.confirm('b', 'b')
    expect(requests).toEqual(['sess-a-1', 'sess-b-1'])
  })

  it('sends a notification without waiting for an answer', () => {
    const { context, notifications, requests } = harness()
    context.notify('working', 'info')
    expect(requests).toHaveLength(0)
    expect(notifications[0]).toMatchObject({
      method: 'notify',
      message: 'working',
      notifyType: 'info'
    })
  })

  it('offers a named headless theme and no interactive surface', () => {
    const { context } = harness()
    // The runner spreads the UI context when it binds extensions, so a theme has
    // to exist even though a hosted session never renders one.
    expect(context.theme.name).toBe('cio-host')
    expect(context.getToolsExpanded()).toBe(false)
    expect(context.getAllThemes()).toEqual([])
    expect(context.getEditorText()).toBe('')
  })
})
