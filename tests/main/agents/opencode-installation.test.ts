import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessRuntime } from '../../../src/main/drivers/harness-runtime'

const mocks = vi.hoisted(() => ({
  discoverHarnessRuntimes: vi.fn(),
  probeHarnessRuntime: vi.fn()
}))

vi.mock('../../../src/main/drivers/harness-runtime', () => ({
  discoverHarnessRuntimes: mocks.discoverHarnessRuntimes,
  probeHarnessRuntime: mocks.probeHarnessRuntime
}))

import {
  cachedOpenCodeInstallation,
  detectOpenCodeInstallation,
  rememberOpenCodeInstallation,
  resetOpenCodeInstallationCache,
  resolvedOpenCodeCommand
} from '../../../src/main/agents/opencode-installation'

function runtime(command: string): HarnessRuntime {
  return {
    command,
    executable: command,
    resolvedPath: `/usr/local/bin/${command}`,
    target: { kind: 'native' }
  }
}

describe('opencode installation detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetOpenCodeInstallationCache()
  })

  it('picks the newest of opencode and opencode2, so v2 supersedes v1', async () => {
    mocks.discoverHarnessRuntimes.mockResolvedValue(
      new Map([
        ['opencode', runtime('opencode')],
        ['opencode2', runtime('opencode2')]
      ])
    )
    mocks.probeHarnessRuntime.mockImplementation(async (target: HarnessRuntime) =>
      target.command === 'opencode'
        ? { ok: true, stdout: '1.18.32\n', stderr: '' }
        : { ok: true, stdout: '2.0.14\n', stderr: '' }
    )

    const installation = await detectOpenCodeInstallation()

    expect(installation).toEqual({ command: 'opencode2', version: '2.0.14', major: 2 })
    expect(resolvedOpenCodeCommand()).toBe('opencode2')
  })

  it('lets a v2 alias reporting a prefixed version line supersede a v1 install', async () => {
    mocks.discoverHarnessRuntimes.mockResolvedValue(
      new Map([
        ['opencode', runtime('opencode')],
        ['opencode2', runtime('opencode2')]
      ])
    )
    // A packaged app launched from the Dock resolves the Homebrew v1 install as
    // the canonical `opencode`, while the v2 install only answers through the
    // `opencode2` alias and prints its line with an `opencode v` prefix.
    mocks.probeHarnessRuntime.mockImplementation(async (target: HarnessRuntime) =>
      target.command === 'opencode'
        ? { ok: true, stdout: '1.18.30\n', stderr: '' }
        : { ok: true, stdout: 'opencode v2.0.18\n', stderr: '' }
    )

    const installation = await detectOpenCodeInstallation()

    expect(installation).toEqual({ command: 'opencode2', version: 'opencode v2.0.18', major: 2 })
    expect(resolvedOpenCodeCommand()).toBe('opencode2')
  })

  it('keeps the canonical opencode command when it is the newer install', async () => {
    mocks.discoverHarnessRuntimes.mockResolvedValue(
      new Map([
        ['opencode', runtime('opencode')],
        ['opencode2', null]
      ])
    )
    mocks.probeHarnessRuntime.mockResolvedValue({ ok: true, stdout: '2.0.14\n', stderr: '' })

    const installation = await detectOpenCodeInstallation()

    expect(installation?.command).toBe('opencode')
    expect(installation?.major).toBe(2)
    expect(resolvedOpenCodeCommand()).toBe('opencode')
  })

  it('reports no install and clears the cache when nothing answers', async () => {
    mocks.discoverHarnessRuntimes.mockResolvedValue(
      new Map([
        ['opencode', null],
        ['opencode2', null]
      ])
    )

    expect(await detectOpenCodeInstallation()).toBeNull()
    expect(cachedOpenCodeInstallation()).toBeNull()
    expect(resolvedOpenCodeCommand()).toBe('opencode')
  })

  it('falls back to the canonical command before any detection has run', () => {
    expect(resolvedOpenCodeCommand()).toBe('opencode')
    rememberOpenCodeInstallation({ command: 'opencode2', version: '2.0.14', major: 2 })
    expect(resolvedOpenCodeCommand()).toBe('opencode2')
  })
})
