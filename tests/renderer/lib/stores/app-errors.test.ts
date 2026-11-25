import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, toastError } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn((_message: string) => 'toast-id')
}))

vi.mock('$lib/ipc.svelte', () => ({ invoke }))
vi.mock('svelte-sonner', () => ({ toast: { error: toastError, warning: vi.fn() } }))
vi.mock('$lib/stores/workspace.svelte', () => ({ workspaceState: { selectedThread: null } }))
vi.mock('$lib/copy-text', () => ({ copyText: vi.fn(async () => {}) }))

const environment = {
  appVersion: '0.5.72-nightly.3',
  platform: 'darwin',
  platformVersion: '15.4.1',
  architecture: 'arm64',
  electronVersion: '43.2.0'
}

const { appErrorState, captureFailure, reportFailure } =
  await import('$lib/stores/app-errors.svelte')

/** Let the environment answer the module asked main for at first capture land. */
async function settleEnvironment(): Promise<void> {
  appErrorState.dismissAll()
  captureFailure(new Error('prime the environment'), 'Priming the environment')
  await new Promise((resolve) => setTimeout(resolve, 0))
  appErrorState.dismissAll()
}

beforeEach(async () => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'logger:environment') return environment
    throw new Error(`Unexpected channel ${channel}`)
  })
  toastError.mockClear()
  await settleEnvironment()
})

describe('a caught failure reaching the Exceptions panel', () => {
  it('keeps the stack instead of the cleaned sentence alone', () => {
    const failure = new TypeError('x is not a function')
    captureFailure(failure, 'Mac mini could not be checked', {
      description: 'x is not a function'
    })

    const [entry] = appErrorState.entries
    expect(entry.message).toBe('Mac mini could not be checked')
    expect(entry.details).toContain('TypeError: x is not a function')
    expect(entry.details).toMatch(/^\s+at /m)
  })

  it('stamps the trace with the version the logger logs, nightly suffix intact', () => {
    captureFailure(new Error('boom'), 'An Oven operation failed')

    const [entry] = appErrorState.entries
    expect(entry.environment).toBe(
      'CodeInOven 0.5.72-nightly.3 · macOS 15.4.1 · arm64 · Electron 43.2.0'
    )
    expect(entry.details?.startsWith(`${entry.environment}\n\n`)).toBe(true)
  })

  it('records a failure once and toasts it once, without a second entry', () => {
    reportFailure(new Error('refused'), 'The Oven could not be saved', {
      description: 'refused'
    })

    expect(appErrorState.entries).toHaveLength(1)
    expect(appErrorState.entries[0].count).toBe(1)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]?.[0]).toBe('The Oven could not be saved')
  })

  it('falls back to the cleaned sentence when the failure carries no stack', () => {
    captureFailure('The SSH key was refused', 'The Oven could not be saved')

    const [entry] = appErrorState.entries
    expect(entry.details).toContain('The SSH key was refused')
  })
})
