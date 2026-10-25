import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../src/lib/types'
import type { StorageEngine } from '../../src/main/storage/storage-engine'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../src/lib/agent-behavior'
import { DEFAULT_SPEECH_SETTINGS } from '../../src/lib/speech/types'
import { DEFAULT_MAX_CONFLICT_FILE_BYTES } from '../../src/lib/types'
import {
  DEFAULT_BACKGROUND_WAKE_LEAD_MS,
  DEFAULT_BROWSER_HIBERNATION_MINUTES,
  DEFAULT_BROWSER_HISTORY_LIMIT,
  DEFAULT_CIO_CLEANUP_RETENTION_DAYS,
  DEFAULT_MAX_BACKGROUND_WAKE_HOLD_MS
} from '../../src/lib/types/settings'
import { DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES } from '../../src/lib/types/cio-cleanup'
import {
  UpdaterService,
  type SessionActivitySource
} from '../../src/main/notifications/updater-service'
import {
  baseVersion,
  isRunningNewestBuild,
  selectNightlyChannelRelease
} from '../../src/main/notifications/updater-install-recovery'

interface MockAutoUpdater {
  isUpdaterActive: () => boolean
  logger: unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL: ReturnType<typeof vi.fn>
  channel: string | null
  allowPrerelease: boolean
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
}

const { autoUpdater, autoUpdaterHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  let channel: string | null = null
  const updater = {
    isUpdaterActive: () => true,
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: vi.fn(),
    allowPrerelease: false,
    get channel(): string | null {
      return channel
    },
    // electron-updater's real setter accepts only a string and throws
    // "Channel must be a string" otherwise. Mirroring that here means a
    // regression back to a null channel makes the stable-channel case fail
    // instead of quietly passing.
    set channel(value: string | null) {
      if (typeof value !== 'string') {
        throw new Error(`Channel must be a string, but got: ${String(value)}`)
      }
      channel = value
    },
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
  // The updater only runs in a shipped build, so the fixture is one: a
  // development launch (isPackaged without a handed app path) has nothing to
  // update and never reaches these flows.
  app: { getVersion: () => '0.1.0', isPackaged: true }
}))

const DEFERRED_POLL_MS = 5_000

function defaultConfig(): AppConfig {
  return {
    theme: 'system',
    fontFamily: 'jetbrains-mono',
    appFontSize: 15,
    fontWeight: 200,
    contrastLevel: 'normal',
    zoomLevel: 1,
    onboardingCompleted: false,
    threadLimit: 70,
    switcherTerminalTabs: true,
    switcherFileTabs: true,
    switcherThreadBrowserTabs: true,
    questionTimeoutMs: 300_000,
    agentQuestionCap: 3,
    keybindings: {},
    slashCommandMode: 'app',
    preferredEditor: 'system',
    openLocalhostInCioBrowser: true,
    openAllLinksInCioBrowser: false,
    allowPrototypeExternalCdn: true,
    prototypeCdnAllowlist: [],
    inAppNotificationSound: { success: true, issue: true },
    memory: { enabled: true, chatEnabled: true, entries: [] },
    agentDefaults: { syncFromThreadChanges: false },
    auxiliaryAgents: {},
    design: { assignments: [] },
    modelProfiles: [],
    mediaGeneration: { providerId: null },
    rankingJudge: { kind: 'automatic' },
    agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
    autoDownloadUpdates: true,
    autoInstallUpdates: true,
    updateChannel: 'stable',
    keepAwakeWhileWorking: false,
    imageDescriptorAskAgain: false,
    autoRetryAfterReset: true,
    resumeWorkOnRestart: true,
    defaultMergeMethod: 'squash',
    defaultPullStrategy: 'ask',
    maxDiffLines: 100,
    maxConflictFileBytes: DEFAULT_MAX_CONFLICT_FILE_BYTES,
    browserHibernationMinutes: DEFAULT_BROWSER_HIBERNATION_MINUTES,
    browserHistoryLimit: DEFAULT_BROWSER_HISTORY_LIMIT,
    browserAllowSiteKeymapOverride: true,
    backgroundMode: 'scheduled',
    launchAtLogin: true,
    launchAtLoginPrompted: false,
    autoRunMissedAssistantRuns: true,
    backgroundWakeLeadMs: DEFAULT_BACKGROUND_WAKE_LEAD_MS,
    maxBackgroundWakeHoldMs: DEFAULT_MAX_BACKGROUND_WAKE_HOLD_MS,
    browserSearchEngine: 'duckduckgo',
    browserCustomSearchEngines: [],
    cioCleanupRetentionDays: DEFAULT_CIO_CLEANUP_RETENTION_DAYS,
    cioCleanupExcludedCategories: [...DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES],
    sound: structuredClone(DEFAULT_SPEECH_SETTINGS)
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
  autoUpdater.allowPrerelease = false
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

  it('treats a live activity source as active work', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))
    const source = { active: true }
    service.addActivitySource({ activeSessionCount: () => (source.active ? 1 : 0) })

    await emitDownloaded()

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(service.status.state).toBe('waiting')

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // A source going idle lets the deferred install proceed.
    source.active = false
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

    // Fresh service shares the same storage   the pending install is resumed.
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

describe('UpdaterService check failure handling', () => {
  it('a background check network failure falls back to idle, not a sticky error', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    autoUpdater.checkForUpdates.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    service.start()
    await flush()

    // electron-updater both emits 'error' and rejects the check promise.
    autoUpdater.emit('error', new Error('getaddrinfo ENOTFOUND'))
    await flush()

    expect(service.status.state).toBe('idle')
    expect(service.status.errorMessage).toBeUndefined()
  })

  it('an explicit user-initiated check failure still reports the error', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))
    const pending = service.checkForUpdates(true)
    await flush()
    autoUpdater.emit('error', new Error('offline'))
    await pending

    expect(service.status.state).toBe('error')
    expect(service.status.errorMessage).toBe('offline')
  })

  it('a background failure never clobbers a downloaded update', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 1))

    await emitDownloaded()
    expect(service.status.state).toBe('waiting')

    autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))
    const pending = service.checkForUpdates()
    autoUpdater.emit('error', new Error('offline'))
    await flush()
    await pending

    expect(service.status.state).toBe('waiting')
  })
})

describe('UpdaterService update channel', () => {
  it('applies the string channel latest for the stable channel', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    await service.checkForUpdates()
    await flush()

    // A null here threw inside electron-updater's setter and left a stale
    // channel behind; the stable feed is the string `latest`.
    expect(autoUpdater.channel).toBe('latest')
    expect(autoUpdater.allowPrerelease).toBe(false)
  })

  it('selects the nightly channel with prereleases, then clears both on stable', async () => {
    const config = defaultConfig()
    config.updateChannel = 'nightly'
    const storage = makeStorage({ getConfig: vi.fn(async () => config) })
    const service = new UpdaterService(storage)

    await service.checkForUpdates()
    expect(autoUpdater.channel).toBe('nightly')
    expect(autoUpdater.allowPrerelease).toBe(true)

    config.updateChannel = 'stable'
    await service.checkForUpdates()
    expect(autoUpdater.channel).toBe('latest')
    expect(autoUpdater.allowPrerelease).toBe(false)
  })

  it('ignores an offered update older than the running build', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    // Running 0.1.0; a nightly of the same core is lower than the release.
    autoUpdater.emit('update-available', { version: '0.1.0-nightly.2', files: [] })
    await flush()

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(service.status.state).toBe('idle')
  })

  it('still downloads an offered update that is genuinely newer', async () => {
    const storage = makeStorage()
    const service = new UpdaterService(storage)
    service.setChatEngine(makeChatEngine(() => 0))

    autoUpdater.emit('update-available', { version: '0.2.0', files: [] })
    await flush()

    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('Nightly channel stable crossover', () => {
  it('reads the base a nightly is a preview of', () => {
    expect(baseVersion('0.5.66-nightly.5')).toBe('0.5.66')
    expect(baseVersion('0.5.66')).toBe('0.5.66')
  })

  it('stays on the nightly feed while stable only reaches the nightly base', () => {
    // The reported case: 0.5.66-nightly.5 installed, 0.5.66 published. Both are
    // the same release, so the feed must not offer a "new" stable build.
    const nightly = { version: '0.5.66-nightly.5' }
    const stable = { version: '0.5.66' }
    expect(selectNightlyChannelRelease(nightly, stable)).toBe(nightly)
  })

  it('stays on the nightly feed when the nightly base is ahead of stable', () => {
    const nightly = { version: '0.5.67-nightly.2' }
    const stable = { version: '0.5.66' }
    expect(selectNightlyChannelRelease(nightly, stable)).toBe(nightly)
  })

  it('crosses over to stable once its base is newer than the nightly feed', () => {
    const nightly = { version: '0.5.65-nightly.2' }
    const stable = { version: '0.5.66' }
    expect(selectNightlyChannelRelease(nightly, stable)).toBe(stable)
  })

  it('treats a bare release of the running nightly base as already installed', () => {
    expect(isRunningNewestBuild('0.5.66-nightly.5', '0.5.66')).toBe(true)
    expect(isRunningNewestBuild('0.5.66-nightly.5', '0.5.67')).toBe(false)
    expect(isRunningNewestBuild('0.5.65-nightly.2', '0.5.66')).toBe(false)
    expect(isRunningNewestBuild('0.5.66-nightly.5', '0.5.66-nightly.4')).toBe(true)
    expect(isRunningNewestBuild('0.5.66', '0.5.66-nightly.5')).toBe(true)
  })
})
