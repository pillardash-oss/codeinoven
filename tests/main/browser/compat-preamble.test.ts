/**
 * The injected compatibility preamble, bundled and run the way a worker runs it.
 *
 * WHAT THIS FILE IS FOR
 * The preamble is 3,600 lines of measured workarounds for namespaces this runtime
 * compiles out, split by concern into `compat/preamble/` and bundled into one IIFE at
 * build time. Nothing else in the suite ever executes it, and its own first rule is
 * that it must never throw: a preamble that throws is worse than no preamble, because
 * the extension's own code then never runs at all. So this file runs the real bundle
 * against the shared runtime fixture and asserts what it left behind.
 *
 * THE NUMBERS ARE EVIDENCE, NOT PREFERENCE
 * `254` installed members and the namespace, state and answer lists below were
 * recorded from the single-closure preamble this refactor replaces, running against
 * this same fixture. A split that changes one of them has changed behaviour, and that
 * is exactly what this test is here to catch.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { bundleCompatSource } from '../../../scripts/lib/compat-source-compiler'
import {
  createMockSurface,
  createTimerRecorder
} from '../../fixtures/browser-extension-chrome-mock'
import type { AnyRecord, TimerRecorder } from '../../fixtures/browser-extension-chrome-mock'

const projectRoot = join(import.meta.dirname, '..', '..', '..')
const entryPath = join(
  projectRoot,
  'src',
  'main',
  'browser',
  'extensions',
  'compat',
  'preamble',
  'index.ts'
)
const sourcePath = 'src/main/browser/extensions/compat/preamble/index.ts'

function bundle(): string {
  return bundleCompatSource({ sourcePath, entryPath, projectRoot })
}

interface Run {
  chrome: AnyRecord
  storage: Map<string, unknown>
  report: AnyRecord
  timers: TimerRecorder
  errors: string[]
}

/** Bundle the preamble and run it the way an installed extension does. */
function runPreamble(): Run {
  const { chrome, storage } = createMockSurface()
  // A distinct `browser` object with the same namespaces, as this runtime really
  // exposes, so every dual-root repair runs.
  const browser = { ...chrome }
  const timers = createTimerRecorder()
  const errors: string[] = []
  const sandbox: AnyRecord = {
    chrome,
    browser,
    navigator: { userAgent: 'Electron/40 Chrome/140' },
    URL,
    crypto,
    console: {
      log: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args.map(String).join(' '))
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setTimeout,
    clearInterval: timers.clearTimeout,
    queueMicrotask,
    Promise,
    BroadcastChannel,
    structuredClone
  }
  runInNewContext(bundle(), sandbox)
  // The preamble schedules its own report writes; fire them so the published payload
  // is part of what this run produced.
  timers.flush()
  return { chrome, storage, report: (sandbox['__cioCompat'] ?? {}) as AnyRecord, timers, errors }
}

/**
 * Await one call while letting the preamble's own timers run.
 *
 * Several answers wait on a capture timer the app runs in the worker (the tab replay
 * gate, the frames query). Those timers are recorded by the fixture rather than
 * scheduled, so a plain `await` would wait for a real one.
 */
async function settle<T>(answer: Promise<T> | T, timers: TimerRecorder): Promise<T> {
  const pending = Promise.resolve(answer)
  for (let round = 0; round < 4; round += 1) {
    timers.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return pending
}

function members(namespace: unknown): string[] {
  if (!namespace || typeof namespace !== 'object') return []
  return Object.getOwnPropertyNames(namespace).sort()
}

const run = runPreamble()
const report = run.report
const chrome = run.chrome
const namespace = (name: string): AnyRecord => chrome[name] as AnyRecord

describe('the injected compatibility preamble', () => {
  it('bundles to one classic-script IIFE that ends with the app’s end marker', () => {
    // The marker is the entry's own trailing comment, and the bundle has to keep it:
    // the app rewrites a stale preamble in an installed copy by splitting the file
    // there, so a bundle that lost it would leave old copies unreachable.
    expect(readFileSync(entryPath, 'utf8')).toContain('// ── CIO compatibility preamble ends here')

    const source = bundle()
    expect(source).not.toMatch(/^[ \t]*(?:import|export)\b/mu)
    // A bundled module is strict by default and the file it replaces was a classic
    // script that never was: a failed assignment in an extension's own world has to
    // stay a no-op, which is why the compiler drops the directive.
    expect(source).not.toMatch(/["']use strict["']/u)
    expect(
      source
        .trimEnd()
        .endsWith(
          '// ── CIO compatibility preamble ends here ─────────────────────────────────────'
        )
    ).toBe(true)
    expect(source.startsWith(`// Bundled from ${sourcePath}`)).toBe(true)
  })

  it('never throws and never records an error', () => {
    // The preamble's first rule. `state.errors` is the only channel it reports on.
    expect(report['errors']).toEqual([])
    expect(run.errors).toEqual([])
  })

  it('records the surface it found, before patching it', () => {
    const surface = report['surface'] as Record<string, string[]>
    expect(Object.keys(surface).sort()).toContain('runtime')
    expect(surface['runtime']).toContain('onConnect')
    expect(report['roots']).toBe(2)
    expect(typeof report['generation']).toBe('string')
    expect(typeof report['preambleAt']).toBe('number')
  })

  it('installs every member the single-closure preamble installed', () => {
    // Recorded from the preamble this refactor replaced, on this same fixture. A
    // difference here is behaviour lost, not a stale number.
    expect((report['installed'] as string[]).length).toBe(254)
    expect(report['namespaces']).toEqual([
      'extension',
      'extension',
      'webNavigation',
      'webNavigation',
      'windows',
      'windows',
      'commands',
      'commands',
      'notifications',
      'notifications',
      'permissions',
      'permissions',
      'history',
      'history',
      'bookmarks',
      'bookmarks',
      'identity',
      'identity',
      'sidePanel',
      'sidePanel',
      'browsingData',
      'browsingData',
      'sessions',
      'sessions',
      'topSites',
      'topSites',
      'search',
      'search',
      'fontSettings',
      'fontSettings',
      'omnibox',
      'omnibox',
      'alarms',
      'alarms',
      'idle',
      'idle',
      'management',
      'management',
      'cookies',
      'cookies',
      'userScripts',
      'userScripts'
    ])
  })

  it('answers the namespace members an extension calls', async () => {
    expect(members(chrome['permissions'])).toEqual([
      'contains',
      'getAll',
      'onAdded',
      'onRemoved',
      'remove',
      'request'
    ])
    expect(members(namespace('downloads'))).toContain('download')
    expect(members(namespace('downloads'))).toContain('search')
    expect(members(namespace('cookies'))).toContain('getAllCookieStores')
    expect(members(namespace('windows'))).toContain('WINDOW_ID_NONE')
    expect(members(namespace('userScripts'))).toContain('configureWorld')
    expect(members(namespace('sidePanel'))).toEqual([
      'close',
      'getOptions',
      'onClosed',
      'onOpened',
      'open',
      'setOptions',
      'setPanelBehavior'
    ])
    expect(members(namespace('notifications'))).toContain('onButtonClicked')
    expect(members(namespace('action'))).toContain('setBadgeText')
    // Replaced, not ensured: the runtime's own tab events never fire.
    expect(members(namespace('tabs'))).toContain('onActivated')
    expect(namespace('tabs')['__cioTabsQueryRepaired']).toBeTruthy()

    const extension = namespace('extension')
    const isAllowedFileSchemeAccess = extension[
      'isAllowedFileSchemeAccess'
    ] as () => Promise<unknown>
    expect(await settle(isAllowedFileSchemeAccess(), run.timers)).toBe(false)

    const getAll = namespace('permissions')['getAll'] as () => Promise<unknown>
    expect(await settle(getAll(), run.timers)).toEqual({
      permissions: [
        'storage',
        'tabs',
        'scripting',
        'webRequest',
        'declarativeNetRequest',
        'nativeMessaging'
      ],
      origins: ['https://*/*']
    })
    const contains = namespace('permissions')['contains'] as (details: unknown) => Promise<unknown>
    expect(await settle(contains({ permissions: ['nativeMessaging'] }), run.timers)).toBe(true)
    expect(await settle(contains({ permissions: ['geolocation'] }), run.timers)).toBe(false)

    const create = namespace('notifications')['create'] as (options: unknown) => Promise<unknown>
    expect(await settle(create({ title: 'hello' }), run.timers)).toBe('cio-notification-1')
    const getOptions = namespace('sidePanel')['getOptions'] as () => Promise<unknown>
    expect(await settle(getOptions(), run.timers)).toEqual({ enabled: true })
    const menu = namespace('contextMenus')['create'] as (properties: unknown) => Promise<unknown>
    expect(await settle(menu({ title: 'menu', contexts: ['page'] }), run.timers)).toBe('cio-menu-1')
    const getScripts = namespace('userScripts')['getScripts'] as () => Promise<unknown>
    expect(await settle(getScripts(), run.timers)).toEqual([])
    const query = namespace('tabs')['query'] as (info: unknown) => Promise<unknown>
    expect(await settle(query({ active: true, currentWindow: true }), run.timers)).toEqual([])
    // A window this runtime does not have, answered by the app's own window 0.
    const getCurrent = namespace('windows')['getCurrent'] as () => Promise<unknown>
    expect(await settle(getCurrent(), run.timers)).toMatchObject({
      id: 0,
      focused: true,
      type: 'normal',
      tabs: []
    })
    // Add-only: a privacy setting the runtime already has is left exactly as it was.
    const network = namespace('privacy')['network'] as AnyRecord
    const networkPredictionEnabled = network['networkPredictionEnabled'] as AnyRecord
    const readPrivacy = networkPredictionEnabled['get'] as () => Promise<unknown>
    expect(await settle(readPrivacy(), run.timers)).toEqual({
      value: true,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('publishes the capability report the app reads back', () => {
    const published = run.storage.get('__cioCompatReport') as AnyRecord
    expect(published).toBeDefined()
    expect(published['installed']).toEqual(report['installed'])
    expect(published['generation']).toBe(report['generation'])
    expect(published['errors']).toEqual([])
  })

  it('reports a missing runtime instead of throwing', () => {
    const sandbox: AnyRecord = {
      navigator: { userAgent: 'Electron/40' },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      queueMicrotask,
      Promise
    }
    expect(() => runInNewContext(bundle(), sandbox)).not.toThrow()
    // One line, from the entry's own guard: no concern module may report anything of
    // its own on a page that has no runtime at all.
    expect((sandbox['__cioCompat'] as AnyRecord)['errors']).toEqual(['no chrome object in scope'])
  })
})
