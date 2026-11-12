/**
 * The install path end to end: the real injected text, written into a real
 * extension's copy by the app's own code.
 *
 * WHAT THIS COVERS THAT THE OTHER TWO DO NOT
 * `compat-preamble.test.ts` proves what the bundle does when a runtime runs it, and
 * the compat guards prove it is built from checked source. Neither touches the seam
 * between them, which is where a bundle can still fail: the block prepended to an
 * extension's background entry is text that the extension's own code follows, so it
 * has to stay parseable as one classic script, keep its end marker exactly (the app
 * rewrites a stale block by splitting there), stay recognised as already installed,
 * and survive a refresh without duplicating itself.
 *
 * The extension here is a fixture rather than a download, but it is shaped like the
 * real thing in the two ways that matter: an MV3 classic worker whose body starts
 * with `(`, which is what Bitwarden's does and what makes a missing terminator a
 * syntax error, and an MV3 module worker, which gets the bootstrap shape instead.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleCompatSource } from '../../../scripts/lib/compat-source-compiler'
import {
  COMPAT_BOOTSTRAP_FILE_NAME,
  COMPAT_BRIDGE_PAGE_FILE_NAME,
  COMPAT_BRIDGE_SCRIPT_FILE_NAME,
  COMPAT_PREAMBLE_FILE_NAME,
  ensureInjectionCurrent,
  injectCompatibilityPreamble
} from '../../../src/main/browser/extensions/browser-extension-inject'
import { createMockSurface } from '../../fixtures/browser-extension-chrome-mock'

const projectRoot = join(import.meta.dirname, '..', '..', '..')

/** The text the app injects, built the way the build builds it. */
const preambleSource = bundleCompatSource({
  sourcePath: 'src/main/browser/extensions/compat/preamble/index.ts',
  entryPath: join(
    projectRoot,
    'src',
    'main',
    'browser',
    'extensions',
    'compat',
    'preamble',
    'index.ts'
  ),
  projectRoot
})

/** The extension's own body: `(` first, like Bitwarden's worker. */
const ENTRY_BODY = `(function () {
  self.__bitwarden = { started: true }
})()
`

const PREAMBLE_END_MARKER = '// ── CIO compatibility preamble ends here'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function extensionCopy(background: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cio-inject-'))
  directories.push(directory)
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Fixture Extension',
      version: '1.0.0',
      permissions: ['storage'],
      background
    })
  )
  await writeFile(join(directory, 'background.js'), ENTRY_BODY)
  return directory
}

describe('installing the compatibility preamble into an extension', () => {
  it('prepends a block that parses as one classic script and leaves the entry runnable', async () => {
    const directory = await extensionCopy({ service_worker: 'background.js' })
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    const outcome = await injectCompatibilityPreamble(directory, manifest, preambleSource)

    expect(outcome).toEqual({ injection: 'prepend-classic', entry: 'background.js' })

    const installed = await readFile(join(directory, 'background.js'), 'utf8')
    // The entry's own body still runs after the preamble, as one script.
    expect(installed.endsWith(ENTRY_BODY)).toBe(true)
    expect(installed).toContain('__cioCompat')
    expect(installed.split(PREAMBLE_END_MARKER).length).toBeGreaterThan(1)
    // A closing brace in the preamble is not the block's end: the marker is, and the
    // prepend's own terminator follows it, so the block can end its own last
    // statement before an entry that begins with `(`.
    const markerAt = installed.indexOf(PREAMBLE_END_MARKER)
    const afterMarker = installed.slice(markerAt + PREAMBLE_END_MARKER.length)
    expect(afterMarker.startsWith(' ─────────────────────────────────────\n')).toBe(true)
    expect(afterMarker.split('\n')[1]).toBe(';')

    // The strongest statement available without a browser: the exact bytes an
    // extension's worker will execute parse, and running them leaves the
    // extension's own body executed and the preamble's report populated.
    const sandbox: Record<string, unknown> = {
      self: {},
      navigator: { userAgent: 'Electron/40 Chrome/140' },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      queueMicrotask,
      Promise
    }
    expect(() => runInNewContext(installed, sandbox)).not.toThrow()
    expect((sandbox['self'] as Record<string, unknown>)['__bitwarden']).toEqual({ started: true })
    expect((sandbox['__cioCompat'] as Record<string, unknown>)['errors']).toEqual([
      'no chrome object in scope'
    ])

    // The sidecar the app rewrites a stale copy from, and the files the bridge page
    // travels with.
    const sidecar = await readFile(join(directory, COMPAT_PREAMBLE_FILE_NAME), 'utf8')
    // The sidecar is the prepended block itself, terminator included, so the
    // app can rewrite exactly this text on a refresh.
    expect(sidecar).toContain(PREAMBLE_END_MARKER)
    expect(sidecar.trimEnd().endsWith(';')).toBe(true)
    expect(sidecar).toBe(installed.slice(0, installed.length - ENTRY_BODY.length))
    for (const name of [COMPAT_BRIDGE_PAGE_FILE_NAME, COMPAT_BRIDGE_SCRIPT_FILE_NAME]) {
      expect((await readFile(join(directory, name), 'utf8')).length).toBeGreaterThan(0)
    }
  })

  it('does not prepend twice, and refreshes a stale block in place', async () => {
    const directory = await extensionCopy({ service_worker: 'background.js' })
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    await injectCompatibilityPreamble(directory, manifest, preambleSource)

    // A second install of a folder that already carries the block.
    const again = await injectCompatibilityPreamble(directory, manifest, preambleSource)
    expect(again.injection).toBe('prepend-classic')
    const afterSecond = await readFile(join(directory, 'background.js'), 'utf8')
    expect(afterSecond.split(PREAMBLE_END_MARKER).length).toBe(2)

    // A new app version refreshes the block instead of stacking another one.
    const refreshed = preambleSource.replace(
      'CIO compatibility preamble',
      'CIO compatibility preamble'
    )
    const status = await ensureInjectionCurrent(directory, manifest, `${refreshed}\n// newer\n`)
    expect(status).toBe('rewritten')
    const afterRefresh = await readFile(join(directory, 'background.js'), 'utf8')
    expect(afterRefresh.endsWith(ENTRY_BODY)).toBe(true)
    expect(afterRefresh.split(PREAMBLE_END_MARKER).length).toBe(2)
    expect(afterRefresh).toContain('// newer')
    expect(await ensureInjectionCurrent(directory, manifest, `${refreshed}\n// newer\n`)).toBe(
      'current'
    )
  })

  it('bootstraps a module worker instead of editing its entry', async () => {
    const directory = await extensionCopy({ service_worker: 'background.js', type: 'module' })
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    const outcome = await injectCompatibilityPreamble(directory, manifest, preambleSource)

    expect(outcome).toEqual({ injection: 'module-bootstrap', entry: 'background.js' })
    expect((manifest['background'] as Record<string, unknown>)['service_worker']).toBe(
      COMPAT_BOOTSTRAP_FILE_NAME
    )
    // A module's own imports are hoisted, so the preamble is imported first and the
    // entry second, and the entry file itself is untouched.
    expect(await readFile(join(directory, COMPAT_BOOTSTRAP_FILE_NAME), 'utf8')).toBe(
      [
        '/* Generated by CodeInOven at install time. Do not edit; reinstalling rewrites it. */',
        `import './${COMPAT_PREAMBLE_FILE_NAME}'`,
        "import './background.js'",
        ''
      ].join('\n')
    )
    expect(await readFile(join(directory, 'background.js'), 'utf8')).toBe(ENTRY_BODY)
  })

  it('writes the preamble the fixture runtime accepts', async () => {
    // The same text, run against the runtime fixture the pre-split preamble was
    // measured on: the injected copy and the tested copy are one artefact here, which
    // is the gap a bundle can fall through.
    const directory = await extensionCopy({ service_worker: 'background.js' })
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    await injectCompatibilityPreamble(directory, manifest, preambleSource)
    const sidecar = await readFile(join(directory, COMPAT_PREAMBLE_FILE_NAME), 'utf8')

    const { chrome } = createMockSurface()
    const browser = { ...chrome }
    const sandbox: Record<string, unknown> = {
      chrome,
      browser,
      navigator: { userAgent: 'Electron/40 Chrome/140' },
      URL,
      crypto,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      queueMicrotask,
      Promise,
      console: { log: () => undefined, warn: () => undefined, error: () => undefined }
    }
    expect(() => runInNewContext(sidecar, sandbox)).not.toThrow()
    const report = sandbox['__cioCompat'] as Record<string, unknown>
    expect(report['errors']).toEqual([])
    expect((report['installed'] as string[]).length).toBe(254)
  })
})
