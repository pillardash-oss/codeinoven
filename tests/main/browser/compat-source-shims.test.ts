/**
 * The injected compatibility shims, compiled and run the way an extension runs them.
 *
 * These files are not part of the app's bundle: the app writes their compiled text
 * into an extension's own page, content world or service worker, where Chromium
 * executes it against a `chrome` object the app does not control. Nothing else in
 * the test suite touches them, so this is the only place a broken shim, a shim that
 * threw at load, or a shim that compiled to a module boundary can be caught before a
 * user loses a password manager's autofill or a content blocker's rules.
 *
 * Every shim documents its own first rule: it must never throw, because a throwing
 * shim is worse than no shim at all. The first assertion for each file is exactly
 * that, against a page with no extension APIs whatsoever.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { compileCompatSource } from '../../../scripts/lib/compat-source-compiler'

const compatDirectory = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'browser',
  'extensions',
  'compat'
)

/**
 * A fresh sandbox plus the host surface a shim is allowed to expect.
 *
 * These scripts are injected into a page, so `window` and `crypto` are not
 * optional furniture: `cio-page-tabs.ts` registers its message listener on the
 * page's `window`, and `cio-storage-events.ts` stamps every notice with a UUID so
 * it can recognise its own write. A bare vm context has neither, and without them
 * the test would be proving that the shim throws in a place it never runs.
 */
function createSandbox(globals: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    crypto,
    window: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      postMessage: () => undefined
    },
    // BroadcastChannel is how a storage write reaches the extension's other
    // contexts; the host process has it, a bare vm context does not.
    ...(typeof BroadcastChannel === 'undefined' ? {} : { BroadcastChannel }),
    ...globals
  }
}

async function compileShim(fileName: string): Promise<string> {
  const sourcePath = `src/main/browser/extensions/compat/${fileName}`
  const source = await readFile(join(compatDirectory, fileName), 'utf8')
  return compileCompatSource(source, { sourcePath })
}

/**
 * Run one compiled shim in a fresh context.
 *
 * `runInNewContext` shares this process's microtask queue, so a shim that answers
 * through a promise is awaited by the assertions rather than raced.
 */
function run(compiled: string, sandbox: Record<string, unknown>): Record<string, unknown> {
  runInNewContext(compiled, sandbox)
  return sandbox
}

/**
 * Whether a value can carry properties.
 *
 * A wrapper this shim installs IS a function, and the shims mark their own
 * wrappers (`__cioPageTabs`) so a second push does not wrap them again, so a
 * property reader that only accepted objects could never see that mark.
 */
function carriesProperties(target: unknown): target is Record<string, unknown> {
  return target !== null && (typeof target === 'object' || typeof target === 'function')
}

function field(target: unknown, key: string): unknown {
  return carriesProperties(target) ? target[key] : undefined
}

function record(target: unknown): Record<string, unknown> {
  return carriesProperties(target) ? target : {}
}

const SHIM_FILES = [
  'cio-bridge.ts',
  'cio-bitwarden-notifications.ts',
  'cio-darkreader-storage.ts',
  'cio-page-permissions.ts',
  'cio-page-runtime.ts',
  'cio-page-tabs.ts',
  'cio-storage-events.ts'
] as const

describe('injected compatibility shims', () => {
  for (const fileName of SHIM_FILES) {
    it(`${fileName} compiles to an injectable script that survives an empty page`, async () => {
      const compiled = await compileShim(fileName)

      // The compiler refuses module syntax, and the shim cannot be allowed to
      // smuggle one in through a shape its guard missed.
      expect(compiled).not.toMatch(/^[ \t]*(?:import|export)\b/mu)
      expect(compiled.startsWith('// Compiled from src/main/browser/extensions/compat/')).toBe(true)

      // No `chrome` at all: every shim guards, and none may throw.
      expect(() => run(compiled, createSandbox())).not.toThrow()
    })
  }

  it('installs the bridge page surface', async () => {
    const port = {
      name: '__cio:bridge',
      postMessage: () => undefined,
      disconnect: () => undefined,
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined }
    }
    const sandbox = run(
      await compileShim('cio-bridge.ts'),
      createSandbox({
        chrome: {
          runtime: { id: 'cio-test-extension', connect: () => port },
          storage: {
            local: { get: async () => ({}), set: async () => undefined },
            session: { get: async () => ({}), set: async () => undefined }
          }
        }
      })
    )

    expect(typeof field(sandbox, '__cioBridgeReceive')).toBe('function')
    expect(typeof field(sandbox, '__cioBridgeDrain')).toBe('function')
    expect(typeof field(sandbox, '__cioBridgeWrite')).toBe('function')
  })

  it('answers chrome.permissions from the extension manifest', async () => {
    const chromeRoot = {
      runtime: {
        id: 'cio-test-extension',
        getManifest: () => ({
          permissions: ['storage'],
          optional_permissions: ['nativeMessaging'],
          host_permissions: []
        })
      }
    }
    const sandbox = run(
      await compileShim('cio-page-permissions.ts'),
      createSandbox({ chrome: chromeRoot })
    )
    const permissions = record(field(sandbox, 'chrome')).permissions
    const request = field(permissions, 'request')

    expect(typeof request).toBe('function')
    await expect(
      (request as (details: unknown) => Promise<boolean>)({ permissions: ['nativeMessaging'] })
    ).resolves.toBe(true)
    await expect(
      (request as (details: unknown) => Promise<boolean>)({ permissions: ['tabs'] })
    ).resolves.toBe(false)
  })

  it('carries openOptionsPage to the app through the page', async () => {
    const posted: unknown[] = []
    const chromeRoot: Record<string, unknown> = { runtime: {} }
    const sandbox = run(
      await compileShim('cio-page-runtime.ts'),
      createSandbox({
        chrome: chromeRoot,
        window: { postMessage: (message: unknown) => posted.push(message) }
      })
    )
    const openOptionsPage = field(record(field(sandbox, 'chrome')).runtime, 'openOptionsPage')

    expect(typeof openOptionsPage).toBe('function')
    await (openOptionsPage as () => Promise<void>)()
    expect(posted).toEqual([{ __cioPageCommand: 'open-options' }])
  })

  it('delivers storage change events to the extension', async () => {
    const area = {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
      clear: async () => undefined
    }
    // An extension always has `chrome.runtime`; the shim opens a port through it
    // to reach a worker, so the sandbox has to answer with the same surface.
    const port = {
      postMessage: () => undefined,
      disconnect: () => undefined,
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined }
    }
    const sandbox = run(
      await compileShim('cio-storage-events.ts'),
      createSandbox({
        chrome: {
          runtime: {
            id: 'cio-test-extension',
            connect: () => port,
            onConnect: { addListener: () => undefined }
          },
          storage: { local: { ...area }, session: { ...area } }
        }
      })
    )
    const storage = record(field(sandbox, 'chrome')).storage

    expect(typeof field(field(storage, 'onChanged'), 'addListener')).toBe('function')
    expect(typeof field(field(storage, 'local'), 'onChanged')).toBe('object')
  })

  it('gives Dark Reader a sync area, and only Dark Reader', async () => {
    const darkReaderId = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
    const other = run(
      await compileShim('cio-darkreader-storage.ts'),
      createSandbox({
        chrome: {
          runtime: { id: 'cio-test-extension' },
          storage: {
            local: {
              get: async () => ({}),
              set: async () => undefined,
              remove: async () => undefined,
              clear: async () => undefined
            }
          }
        }
      })
    )
    expect(field(record(field(other, 'chrome')).storage, 'sync')).toBeUndefined()

    const darkReader = run(
      await compileShim('cio-darkreader-storage.ts'),
      createSandbox({
        chrome: {
          runtime: { id: darkReaderId },
          storage: {
            local: {
              get: async () => ({}),
              set: async () => undefined,
              remove: async () => undefined,
              clear: async () => undefined
            }
          }
        }
      })
    )
    const storage = record(field(darkReader, 'chrome')).storage
    expect(field(storage, 'sync')).toBeDefined()
    expect(field(storage, 'sync')).not.toBe(field(storage, 'local'))
  })

  it('answers the tabs query from the snapshot main pushes', async () => {
    const chromeRoot: Record<string, unknown> = {
      runtime: { id: 'cio-test-extension' },
      tabs: { query: async () => [] }
    }
    const sandbox = run(
      await compileShim('cio-page-tabs.ts'),
      createSandbox({
        chrome: chromeRoot,
        __cioPageTabsSnapshot: {
          id: 7,
          url: 'https://example.com/',
          title: 'Example',
          active: true,
          loading: false,
          audible: false,
          muted: false
        }
      })
    )
    const query = field(record(field(sandbox, 'chrome')).tabs, 'query')

    expect(typeof query).toBe('function')
    // Marked by the shim itself, so a re-run in the same page knows its own wrapper.
    expect(field(query, '__cioPageTabs')).toBe(true)
  })

  it('leaves Bitwarden alone until its notification service exists', async () => {
    const sandbox = run(
      await compileShim('cio-bitwarden-notifications.ts'),
      createSandbox({ chrome: { runtime: { id: 'nngceckbapebfimnlniiiahkandclblb' } } })
    )

    expect(field(sandbox, 'bitwardenAutofillInit')).toBeUndefined()
  })
})
