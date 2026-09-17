/**
 * Build the pinned MLX speech worker (macOS on Apple Silicon only).
 *
 * mlx-swift compiles Metal kernels through its `Cmlx` target, so this package is
 * the one worker that needs the separable Xcode Metal toolchain. Both outputs  
 * the `mlx-worker` executable and the checksum-verified `mlx.metallib` from the
 * pinned MLX Metal wheel   resolve through the shared build cache, so a worktree
 * reuses the project root's build instead of recompiling it (see
 * `scripts/lib/speech-worker-build.ts`).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureCachedAsset,
  ensureSpeechWorker,
  speechRuntimeDirectory,
  speechWorkersSupportedHere
} from './lib/speech-worker-build'

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const packageDirectory = join(projectRoot, 'resources/speech/mlx-worker-src')
const buildDirectory = join(projectRoot, '.cio/tmp/mlx-speech-worker-build')
const runtimeDirectory = speechRuntimeDirectory(projectRoot)
const metallibPath = join(runtimeDirectory, 'mlx.metallib')
const metalWheelPath = join(buildDirectory, 'mlx-metal.whl')
const metalWheelDirectory = join(buildDirectory, 'mlx-metal-wheel')
const metalWheel = {
  url: 'https://files.pythonhosted.org/packages/39/66/2313497fdbc7fbadf8e026c09366e3f049f9114e65ca4edc23cdb8699186/mlx_metal-0.31.1-py3-none-macosx_14_0_arm64.whl',
  sha256: '70741174131dbf7fdd479cb730e06e08c358eac3bf7905d9e884e7960cfdd5b8'
} as const

if (!speechWorkersSupportedHere()) process.exit(0)

await ensureSpeechWorker(projectRoot, {
  label: 'MLX speech worker',
  cacheName: 'mlx-worker',
  packageDirectory,
  product: 'mlx-worker',
  scratchDirectory: buildDirectory,
  requiresMetalToolchain: true
})

await ensureCachedAsset(projectRoot, {
  label: 'MLX Metal library',
  cacheName: 'mlx-metal',
  // The library is extracted from a checksum-pinned wheel, so the pinned digest
  // identifies its content exactly and any file already installed came from it.
  cacheKey: metalWheel.sha256,
  artifactName: 'mlx.metallib',
  destination: metallibPath,
  adoptExistingDestination: true,
  produce: produceMetallib
})

/** Verify the pinned wheel (cached, else downloaded), then extract the library. */
async function produceMetallib(): Promise<string> {
  await mkdir(buildDirectory, { recursive: true })
  let wheelValid = false
  try {
    wheelValid =
      createHash('sha256')
        .update(await readFile(metalWheelPath))
        .digest('hex') === metalWheel.sha256
  } catch {
    // A missing or unreadable cached wheel is downloaded below.
  }
  if (!wheelValid) {
    const response = await fetch(metalWheel.url)
    if (!response.ok) throw new Error(`MLX Metal download failed with HTTP ${response.status}.`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== metalWheel.sha256) throw new Error('MLX Metal download checksum mismatch.')
    await writeFile(metalWheelPath, bytes)
  }

  await rm(metalWheelDirectory, { recursive: true, force: true })
  await mkdir(metalWheelDirectory, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/ditto', ['-x', '-k', metalWheelPath, metalWheelDirectory], {
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`MLX Metal extraction exited with code ${code ?? 'unknown'}.`))
    })
  })

  const extracted = await findMetallib(metalWheelDirectory)
  if (!extracted) throw new Error('The verified MLX Metal wheel contained no mlx.metallib.')
  return extracted
}

async function findMetallib(directory: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === 'mlx.metallib') return path
    if (entry.isDirectory()) {
      const nested = await findMetallib(path)
      if (nested) return nested
    }
  }
  return null
}
