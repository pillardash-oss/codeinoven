import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MlxMetalRuntime,
  MLX_METAL_PINNED,
  writeMetalLibraryStub
} from '../../../src/main/speech/mlx-metal-runtime'

/**
 * The MLX engine only exists on macOS on Apple silicon. Everywhere else the
 * runtime is inert by design, so these cases are skipped rather than faked.
 */
const supported = process.platform === 'darwin' && process.arch === 'arm64'

describe.skipIf(!supported)('MlxMetalRuntime', () => {
  let root: string
  let appDirectory: string
  let runtimeDirectory: string
  let workerSource: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mlx-runtime-test-'))
    appDirectory = join(root, 'app')
    runtimeDirectory = join(root, 'runtime')
    workerSource = join(appDirectory, 'mlx-worker')
    await mkdir(appDirectory, { recursive: true })
    await writeFile(workerSource, 'worker-binary')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    delete process.env['CODEINOVEN_MLX_METALLIB_PATH']
    delete process.env['MLX_METALLIB_PATH']
  })

  it('reuses a library discovered beside the worker and links both files', async () => {
    await writeMetalLibraryStub(join(appDirectory, 'mlx.metallib'))
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    const workerPath = await runtime.prepare()

    expect(workerPath).toBe(join(runtimeDirectory, MLX_METAL_PINNED.workerFileName))
    // A hard link, not a copy: the bundled worker must not be duplicated on disk.
    expect((await stat(workerPath)).ino).toBe((await stat(workerSource)).ino)
    expect(
      (await stat(join(runtimeDirectory, MLX_METAL_PINNED.metallibFileName))).size
    ).toBeGreaterThan(0)
    await expect(runtime.status(true)).resolves.toMatchObject({
      supported: true,
      available: true,
      prepared: true,
      source: 'development'
    })
  })

  it('reports a missing engine instead of failing the capability probe', async () => {
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
    await expect(runtime.status(true)).resolves.toMatchObject({
      supported: true,
      available: false,
      prepared: false,
      downloadRequired: true
    })
    expect(runtime.unavailableReason()).toContain('not installed yet')
  })

  it('honours an explicit library override', async () => {
    const override = join(root, 'elsewhere.metallib')
    await writeMetalLibraryStub(override)
    process.env['CODEINOVEN_MLX_METALLIB_PATH'] = override
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    await runtime.prepare()

    await expect(runtime.status(true)).resolves.toMatchObject({
      source: 'environment',
      selectedPath: override
    })
  })

  it('prefers the app-managed copy over one discovered beside the worker', async () => {
    await mkdir(runtimeDirectory, { recursive: true })
    await writeMetalLibraryStub(
      join(runtimeDirectory, MLX_METAL_PINNED.metallibFileName),
      9_000_000
    )
    await writeMetalLibraryStub(join(appDirectory, 'mlx.metallib'))
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    await runtime.prepare()

    await expect(runtime.status(true)).resolves.toMatchObject({ source: 'managed' })
  })

  it('re-links the discovered library after the managed copy is removed', async () => {
    await writeMetalLibraryStub(join(appDirectory, 'mlx.metallib'))
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)
    await runtime.prepare()

    await runtime.removeManaged()

    await expect(runtime.prepare()).resolves.toBe(
      join(runtimeDirectory, MLX_METAL_PINNED.workerFileName)
    )
    await expect(runtime.status(true)).resolves.toMatchObject({ source: 'development' })
  })

  it('rejects a file that is not a Metal binary library', async () => {
    await writeFile(join(appDirectory, 'mlx.metallib'), Buffer.alloc(9_000_000, 7))
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
  })

  it('rejects a truncated Metal library', async () => {
    // The right magic bytes, but far too small to hold the kernel set.
    await writeFile(join(appDirectory, 'mlx.metallib'), Buffer.from('MTLB', 'ascii'))
    const runtime = new MlxMetalRuntime(workerSource, runtimeDirectory)

    await expect(runtime.prepare()).rejects.toThrow(/not installed yet/u)
  })
})
