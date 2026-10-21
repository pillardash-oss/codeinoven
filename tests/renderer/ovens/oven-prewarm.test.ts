import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/ipc.svelte', () => ({ invoke }))

const { prewarmThreadOven } = await import('../../../src/renderer/lib/ovens/oven-prewarm')

beforeEach(() => {
  invoke.mockClear()
})

describe('opening a chat that lives on an Oven', () => {
  it('opens that Oven session before the user does anything', () => {
    prewarmThreadOven({ settings: { ovenId: 'oven-a' } })
    expect(invoke).toHaveBeenCalledWith('oven:warm', 'oven-a')
  })

  it('leaves a local thread alone', () => {
    prewarmThreadOven({ settings: { ovenId: 'local' } })
    prewarmThreadOven({ settings: {} })
    prewarmThreadOven(null)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('never waits for the connection to open', () => {
    // The call is fire and forget, so opening a chat cannot stall on a machine
    // that is asleep; the first real request retries the session itself.
    invoke.mockImplementationOnce(() => new Promise<never>(() => undefined))
    expect(() => prewarmThreadOven({ settings: { ovenId: 'oven-a' } })).not.toThrow()
  })
})
