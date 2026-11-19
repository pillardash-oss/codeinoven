import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OvenProbe, OvenWorkspaceRequest, OvenWorkspaceResult } from '../../../src/lib/ovens'
import {
  ovenPiExtensionsRoot,
  ovenPiSessionExtensionsRoot,
  publishOvenPiExtensions,
  readPiExtensionFiles,
  type OvenPiExtensionFiles,
  type OvenPiExtensionService
} from '../../../src/main/ovens/oven-pi-extensions'
import { ovenDataRoot, ovenDirKey } from '../../../src/main/ovens/remote/oven-root-paths'

const HOME = '/home/ova'
const SESSION = 'oven-6a1f0d3c'
const CORE = 'export default function core(): void {}\n'
const PROVIDERS = 'export default function providers(): void {}\n'

function probeFor(home: string): OvenProbe {
  return {
    protocolVersion: 1,
    serviceRevision: 'test',
    platform: 'linux',
    architecture: 'x64',
    home,
    nodeVersion: '22.13.0',
    harnesses: [],
    activeRuns: 0
  }
}

function files(core: string = CORE, providers: string | null = PROVIDERS): OvenPiExtensionFiles {
  return {
    coreTools: { name: 'cio-core-tools.ts', content: core },
    ...(providers === null ? {} : { providers: { name: 'providers.ts', content: providers } })
  }
}

/**
 * The Oven's file API, in memory.
 *
 * Only the operations the publisher may use exist, so an unexpected call is a
 * test failure rather than a silently accepted request, and every call is kept
 * so a test can assert what a second publish did and did not do.
 */
class FakeOven implements OvenPiExtensionService {
  readonly calls: OvenWorkspaceRequest[] = []
  readonly stored = new Map<string, Buffer>()
  /** Fail one request, to prove a publish failure is thrown instead of hidden. */
  fail: ((input: OvenWorkspaceRequest) => boolean) | null = null

  constructor(private readonly home: string = HOME) {}

  async probe(): Promise<OvenProbe> {
    return probeFor(this.home)
  }

  operations(): string[] {
    return this.calls.map((call) => call.operation)
  }

  async workspace(_id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    if (this.fail?.(input)) throw new Error('No space left on device.')
    this.calls.push(input)
    switch (input.operation) {
      case 'ensure':
        return { root: input.root }
      case 'read': {
        const data = this.stored.get(input.path)
        if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return {
          root: input.root,
          data: data.subarray(input.offset).toString('base64'),
          size: data.length
        }
      }
      case 'stat': {
        const data = this.stored.get(input.path)
        if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return {
          root: input.root,
          file: { path: input.path, kind: 'file', size: data.length, modifiedAt: 0, mode: 0o600 }
        }
      }
      case 'write': {
        const existing = this.stored.get(input.path)
        if (input.exclusive && existing) throw new Error('The file already exists.')
        const chunk = Buffer.from(input.data, 'base64')
        const target = Buffer.alloc(Math.max(existing?.length ?? 0, input.offset + chunk.length))
        existing?.copy(target)
        chunk.copy(target, input.offset)
        this.stored.set(input.path, target)
        return { root: input.root }
      }
      case 'replace': {
        const staged = this.stored.get(input.staged)
        if (!staged) throw new Error('The staged file is not there.')
        this.stored.delete(input.staged)
        this.stored.set(input.path, staged)
        return { root: input.root }
      }
      default:
        throw new Error(`Unexpected workspace operation: ${input.operation}`)
    }
  }
}

afterEach(() => {
  rm(join(tmpdir(), 'cio-pi-extensions-'), { force: true }).catch(() => undefined)
})

describe('publishing the app pi extensions to an Oven', () => {
  it('creates the session directory and returns the --extension argv under the data root', async () => {
    const oven = new FakeOven()
    const result = await publishOvenPiExtensions({
      service: oven,
      ovenId: 'oven-a',
      sessionId: SESSION,
      files: files()
    })
    const root = `${ovenDataRoot(HOME)}/pi-extensions/${ovenDirKey(SESSION)}`
    expect(root.startsWith(`${ovenPiExtensionsRoot(HOME)}/`)).toBe(true)
    expect(root.startsWith('/home/ova\u002f.config/pillardash/codeinoven/ovens/')).toBe(true)
    expect(result.extensionArgs).toEqual([
      '--extension',
      `${root}/cio-core-tools.ts`,
      '--extension',
      `${root}/providers.ts`
    ])
    expect(oven.operations()[0]).toBe('ensure')
    expect(oven.calls[0]).toEqual({ operation: 'ensure', root })
    expect(oven.stored.get('cio-core-tools.ts')?.toString('utf8')).toBe(CORE)
    expect(oven.stored.get('providers.ts')?.toString('utf8')).toBe(PROVIDERS)
    // The module is published through a staged file and renamed into place, so
    // pi can never load a half-written extension.
    const moduleReplaces = oven.calls.filter(
      (call) => call.operation === 'replace' && !call.path.includes('.sha256')
    )
    expect(moduleReplaces).toHaveLength(2)
    expect(
      oven.calls.find((call) => call.operation === 'replace' && call.path === 'cio-core-tools.ts')
    ).toMatchObject({ mode: 0o600 })
  })

  it('does not rewrite unchanged content on the next publish', async () => {
    const oven = new FakeOven()
    const input = { service: oven, ovenId: 'oven-a', sessionId: SESSION, files: files() }
    await publishOvenPiExtensions(input)
    const before = oven.calls.length
    const result = await publishOvenPiExtensions(input)
    const second = oven.operations().slice(before)
    expect(second).toEqual(['ensure', 'read', 'stat', 'read', 'stat'])
    expect(result.extensionArgs).toHaveLength(4)
    expect(oven.stored.get('cio-core-tools.ts')?.toString('utf8')).toBe(CORE)
  })

  it('rewrites a module whose content changed', async () => {
    const oven = new FakeOven()
    const input = { service: oven, ovenId: 'oven-a', sessionId: SESSION }
    await publishOvenPiExtensions({ ...input, files: files() })
    const before = oven.calls.length
    await publishOvenPiExtensions({
      ...input,
      files: files(`${CORE}// a provider edit reached this process\n`)
    })
    const second = oven.operations().slice(before)
    expect(second).toContain('write')
    expect(second).toContain('replace')
    expect(oven.stored.get('cio-core-tools.ts')?.toString('utf8')).toContain('a provider edit')
  })

  it('omits the providers extension when pi materialized none', async () => {
    const oven = new FakeOven()
    const result = await publishOvenPiExtensions({
      service: oven,
      ovenId: 'oven-a',
      sessionId: SESSION,
      files: files(CORE, null)
    })
    const root = ovenPiSessionExtensionsRoot(HOME, SESSION)
    expect(result.extensionArgs).toEqual(['--extension', `${root}/cio-core-tools.ts`])
    expect(oven.stored.has('providers.ts')).toBe(false)
  })

  it('rejects instead of running pi when a write fails, naming the extension', async () => {
    const oven = new FakeOven()
    oven.fail = (call) => call.operation === 'write' && call.path.includes('cio-core-tools.ts')
    await expect(
      publishOvenPiExtensions({
        service: oven,
        ovenId: 'oven-a',
        sessionId: SESSION,
        files: files()
      })
    ).rejects.toThrow(/cio-core-tools extension .*cio-core-tools\.ts/u)
    // Nothing was renamed into place, so the next attempt starts from clean state.
    expect(oven.stored.has('cio-core-tools.ts')).toBe(false)
  })

  it('splits a module larger than one Oven write into offset chunks', async () => {
    const oven = new FakeOven()
    const large = `// ${'x'.repeat(200 * 1024)}\n`
    await publishOvenPiExtensions({
      service: oven,
      ovenId: 'oven-a',
      sessionId: SESSION,
      files: files(large, null)
    })
    // The digest beside the module is its own tiny file; only the module is chunked.
    const writes = oven.calls.filter(
      (call) =>
        call.operation === 'write' &&
        call.path.startsWith('cio-core-tools.ts.') &&
        !call.path.includes('.sha256')
    )
    expect(writes.map((call) => (call.operation === 'write' ? call.offset : -1))).toEqual([
      0,
      128 * 1024
    ])
    expect(oven.stored.get('cio-core-tools.ts')?.toString('utf8')).toBe(large)
  })

  it('refuses a file name that would leave the extension directory', async () => {
    const oven = new FakeOven()
    await expect(
      publishOvenPiExtensions({
        service: oven,
        ovenId: 'oven-a',
        sessionId: SESSION,
        files: { coreTools: { name: '../evil.ts', content: CORE } }
      })
    ).rejects.toThrow(/unsafe file name/u)
    expect(oven.calls).toHaveLength(0)
  })

  it('rejects an Oven that reports no home directory', async () => {
    const oven = new FakeOven('')
    await expect(
      publishOvenPiExtensions({
        service: oven,
        ovenId: 'oven-a',
        sessionId: SESSION,
        files: files()
      })
    ).rejects.toThrow(/home directory/u)
    expect(oven.calls).toHaveLength(0)
  })

  it('keeps the Windows Oven path form the rest of the app uses', async () => {
    const windowsHome = 'C:\\Users\\ova'
    const oven = new FakeOven(windowsHome)
    const result = await publishOvenPiExtensions({
      service: oven,
      ovenId: 'oven-a',
      sessionId: SESSION,
      files: files()
    })
    const root = `${windowsHome}/.config/pillardash/codeinoven/ovens/pi-extensions/${ovenDirKey(SESSION)}`
    expect(root).toBe(ovenPiSessionExtensionsRoot(windowsHome, SESSION))
    expect(result.extensionArgs).toEqual([
      '--extension',
      `${root}/cio-core-tools.ts`,
      '--extension',
      `${root}/providers.ts`
    ])
    expect(
      result.extensionArgs[1]?.startsWith('C:\\Users\\ova/.config/pillardash/codeinoven/ovens/')
    ).toBe(true)
  })
})

describe('reading the local pi extension sources', () => {
  it('returns the modules a local spawn would pass, under their own file names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cio-pi-extensions-'))
    try {
      const corePath = join(directory, 'cio-core-tools.ts')
      const providersPath = join(directory, 'providers.ts')
      await writeFile(corePath, CORE, 'utf8')
      await writeFile(providersPath, PROVIDERS, 'utf8')
      expect(await readPiExtensionFiles({ coreToolsPath: corePath, providersPath })).toEqual({
        coreTools: { name: 'cio-core-tools.ts', content: CORE },
        providers: { name: 'providers.ts', content: PROVIDERS }
      })
      expect(await readPiExtensionFiles({ coreToolsPath: corePath })).toEqual({
        coreTools: { name: 'cio-core-tools.ts', content: CORE }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('names the missing materialized module instead of publishing nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cio-pi-extensions-'))
    try {
      await expect(
        readPiExtensionFiles({ coreToolsPath: join(directory, 'cio-core-tools.ts') })
      ).rejects.toThrow(/cio-core-tools extension/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
