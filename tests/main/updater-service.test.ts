import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../src/lib/types'
import type { StorageEngine } from '../../src/main/storage/storage-engine'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../src/lib/agent-behavior'
import {
  UpdaterService,
  type SessionActivitySource
} from '../../src/main/notifications/updater-service'

interface MockAutoUpdater {
  isUpdaterActive: () => boolean
  logger: unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  channel: string | null
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
}

const { autoUpdater, autoUpdaterHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const updater = {
    isUpdaterActive: () => true,
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: null,
    checkForUpdates: vi.fn(() => Promise.resolve()),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    },
    emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args)
    }
  } as MockAutoUpdater
  return { autoUpdater: updater, autoUpdaterHandlers: handlers }
})

vi.mock('electron-updater', () => ({ default: { autoUpdater } }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getVersion: () => '0.1.0' }
}))

const DEFERRED_POLL_MS = 5_000

function defaultConfig(): AppConfig {
  return {
    theme: 'system',
    onboardingCompleted: false,
    threadLimit: 70,
    questionTimeoutMs: 300_000,
    keybindings: {},
    slashCommandMode: 'app',
    preferredEditor: 'system',
    openLocalhostInCioBrowser: true,
    memory: { enabled: true, chatEnabled: true, entries: [] },
    agentDefaults: { syncFromThreadChanges: false },
    agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
    autoDownloadUpdates: true,
    autoInstallUpdates: true,
    updateChannel: 'stable',
    keepAwakeWhileWorking: false,
    keepAwakeWhileRemoteConnected: true,
    imageDescriptorAskAgain: false,
    autoRetryAfterReset: true,
    resumeWorkOnRestart: true,
    defaultMergeMethod: 'squash',
    defaultPullStrategy: 'ask',
    maxDiffLines: 100
  }
}

interface StorageHarness extends StorageEngine {
  files: Map<string, unknown>
}

function makeStorage(overrides: Partial<StorageEngine> = {}): StorageHarness {
  const files = new Map<string, unknown>()
  const storage = {
    getConfig: vi.fn(async () => defaultConfig()),
    read: vi.fn(async <T>(path: string) => (files.get(path) as T | undefined) ?? null),
    write: vi.fn(async (path: string, data: unknown) => {
      files.set(path, data)
    }),
    ...overrides
  } as unknown as StorageHarness
  storage.files = files
  return storage
}

function makeChatEngine(active: () => number): SessionActivitySource {
  return { activeSessionCount: active }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  autoUpdaterHandlers.clear()
  autoUpdater.quitAndInstall.mockClear()
  autoUpdater.checkForUpdates.mockClear()
  autoUpdater.checkForUpdates.mockResolvedValue(undefined)
  autoUpdater.downloadUpdate.mockClear()
  autoUpdater.downloadUpdate.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

async function emitDownloaded(version = '9.9.9'): Promise<void> {
  autoUpdater.emit('update-downloaded', { version })
  await flush()
}

describe('UpdaterService session-safe install', () => {
  it('auto-installs immediately when every session is idle', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    await emitDownloaded()

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(service.status.state).toBe('idle')
  })

  it('does not auto-quit while any interactive or child-process work remains', async () => {
    const states = [
      'working',
      'permission',
      'question',
      'tool',
      'compaction',
      'child-process',
      'unresolved-draft'
    ] as const

    for (const state of states) {
      autoUpdater.quitAndInstall.mockClear()
      const storage = makeStorage()
      const service = new UpdaterService(storage)
      const active = { value: 1 }
      service.setChatEngine(makeChatEngine(() => active.value))

      await emitDownloaded()

      expect(autoUpdater.quitAndInstall, `state=${state}`).not.toHaveBeenCalled()
      expect(service.status.state, `state=${state}`).toBe('waiting')

      // A long-running command must never be force-interrupted.
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
      expect(autoUpdater.quitAndInstall, `state=${state}`).not.toHaveBeenCalled()

      active.value = 0
      await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
      expect(autoUpdater.quitAndInstall, `state=${state}`).toHaveBeenCalledTimes(1)
      expect(service.status.state, `state=${state}`).toBe('idle')
    }
  })

  it('treats a live terminal session as active work', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))
    const terminals = { value: 1 }
    service.addActivitySource({ activeSessionCount: () => terminals.value })

    await emitDownloaded()

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('waiting')

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // Closing the terminal lets the deferred install proceed exactly once.
    terminals.value = 0
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(service.status.state).toBe('idle')
  })

  it('treats a live remote session as active work', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))
    const remote = { blockedQuit: true }
    service.addActivitySource({ activeSessionCount: () => (remote.blockedQuit ? 1 : 0) })

    await emitDownloaded()

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('waiting')

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // Unblocking the remote session lets the deferred install proceed.
    remote.blockedQuit = false
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(service.status.state).toBe('idle')
  })

  it('idle-deferred installation executes exactly once', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    const active = { value: 1 }
    service.setChatEngine(makeChatEngine(() => active.value))

    await emitDownloaded()
    expect(service.status.state).toBe('waiting')

    active.value = 0
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS * 5)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('defers again when a new session becomes active while waiting', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    const active = { value: 1 }
    service.setChatEngine(makeChatEngine(() => active.value))

    await emitDownloaded()
    expect(service.status.state).toBe('waiting')

    // A session reports idle, but another one starts before the poll fires.
    active.value = 0
    active.value = 1
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('waiting')

    active.value = 0
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(service.status.state).toBe('idle')
  })

  it('explicit approval installs immediately when idle', async () => {
    const config = defaultConfig()
    config.autoInstallUpdates = false
    const storage = makeStorage({ getConfig: vi.fn(async () => config) })
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    await emitDownloaded()
    expect(service.status.state).toBe('downloaded')

    service.quitAndInstall()
    await flush()

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('explicit approval defers to idle and never forces', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    const active = { value: 1 }
    service.setChatEngine(makeChatEngine(() => active.value))

    await emitDownloaded()
    autoUpdater.quitAndInstall.mockClear()
    expect(service.status.state).toBe('waiting')

    service.quitAndInstall()
    await flush()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('waiting')

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    active.value = 0
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not auto-install when automatic install is disabled', async () => {
    const config = defaultConfig()
    config.autoInstallUpdates = false
    const storage = makeStorage({ getConfig: vi.fn(async () => config) })
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    await emitDownloaded()

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('downloaded')
  })

  it('persists a pending install and resumes it on the next launch', async () => {
    const storage = makeStorage()
    const first = new UpdaterService(storage)
    const active = { value: 1 }
    first.setChatEngine(makeChatEngine(() => active.value))

    await emitDownloaded()
    expect(first.status.state).toBe('waiting')
    first.stop()

    // Fresh service shares the same storage — the pending install is resumed.
    const resumed = new UpdaterService(storage)
    resumed.setChatEngine(makeChatEngine(() => 0))
    resumed.start()
    await flush()

    // Simulate electron-updater re-emitting the cached download on the new run.
    await emitDownloaded()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(resumed.status.state).toBe('idle')
  })

  it('clean shutdown stops the deferred poll without losing the pending install', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    const active = { value: 1 }
    service.setChatEngine(makeChatEngine(() => active.value))

    await emitDownloaded()
    expect(service.status.state).toBe('waiting')

    service.stop()
    active.value = 0
    await vi.advanceTimersByTimeAsync(DEFERRED_POLL_MS * 5)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    expect(storage.files.get('updater/install-pending.json')).toEqual({
      pending: true,
      approved: false
    })
  })
})
