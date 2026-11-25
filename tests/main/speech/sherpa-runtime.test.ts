import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SherpaRuntime, SHERPA_RUNTIME_PINNED } from '../../../src/main/speech/sherpa-runtime'

/** Only the platforms the registry publishes a package for can be provisioned. */
const platformKey = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const packageName = SHERPA_RUNTIME_PINNED.packages[platformKey]?.name
const supported = packageName !== undefined

describe.skipIf(!supported)('SherpaRuntime', () => {
  let root: string
  let wrapperSource: string
  let runtimeDirectory: string
  let runtime: SherpaRuntime

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sherpa-runtime-test-'))
    wrapperSource = join(root, 'app', 'sherpa-onnx-node')
    runtimeDirectory = join(root, 'runtime')
    await mkdir(wrapperSource, { recursive: true })
    await writeFile(
      join(wrapperSource, 'package.json'),
      JSON.stringify({ name: 'sherpa-onnx-node', main: 'sherpa-onnx.js' })
    )
    await writeFile(join(wrapperSource, 'sherpa-onnx.js'), 'module.exports = {}')
    runtime = new SherpaRuntime(wrapperSource, runtimeDirectory)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a missing engine instead of failing the capability probe', async () => {
    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
    await expect(runtime.status(true)).resolves.toMatchObject({
      supported: true,
      available: false,
      prepared: false,
      downloadRequired: true
    })
    expect(runtime.unavailableReason()).toContain('not installed yet')
  })

  it('pairs the bundled wrapper with a provisioned platform package', async () => {
    const moduleRoot = runtime.moduleRoot()
    const platformDirectory = join(moduleRoot, packageName)
    await mkdir(platformDirectory, { recursive: true })
    await writeFile(join(platformDirectory, SHERPA_RUNTIME_PINNED.addonFileName), 'addon')

    const resolved = await runtime.prepare()

    expect(resolved).toBe(moduleRoot)
    // The wrapper is copied, not linked: it ships inside app.asar, which cannot
    // be hard-linked, and the addon's own `../sherpa-onnx-<platform>/` lookup
    // needs the two packages side by side in one node_modules tree.
    const wrapperManifest = JSON.parse(
      await readFile(
        join(moduleRoot, SHERPA_RUNTIME_PINNED.wrapperPackageName, 'package.json'),
        'utf8'
      )
    ) as { name: string }
    expect(wrapperManifest.name).toBe('sherpa-onnx-node')
    await expect(runtime.status(true)).resolves.toMatchObject({
      available: true,
      prepared: true,
      downloadRequired: false
    })
  })

  it('re-links after the managed engine is removed', async () => {
    const moduleRoot = runtime.moduleRoot()
    const platformDirectory = join(moduleRoot, packageName)
    await mkdir(platformDirectory, { recursive: true })
    await writeFile(join(platformDirectory, SHERPA_RUNTIME_PINNED.addonFileName), 'addon')
    await runtime.prepare()

    await runtime.removeManaged()

    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
    await expect(runtime.status(true)).resolves.toMatchObject({ available: false })
  })

  it('refuses to claim readiness without the native addon', async () => {
    const platformDirectory = join(runtime.moduleRoot(), packageName)
    await mkdir(platformDirectory, { recursive: true })
    // A wrapper-only tree: the package directory exists but has no addon, which
    // is what an interrupted download would leave behind if it were not atomic.
    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
  })
})
