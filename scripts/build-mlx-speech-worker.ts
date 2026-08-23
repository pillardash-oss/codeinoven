import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const packageDirectory = join(projectRoot, 'resources/speech/mlx-worker-src')
const buildDirectory = join(projectRoot, '.cio/tmp/mlx-speech-worker-build')
const outputDirectory = join(projectRoot, 'resources/speech/runtime/darwin-arm64')
const outputPath = join(outputDirectory, 'mlx-worker')
const metallibPath = join(outputDirectory, 'mlx.metallib')
const metalWheelPath = join(buildDirectory, 'mlx-metal.whl')
const metalWheelDirectory = join(buildDirectory, 'mlx-metal-wheel')
const metalWheel = {
  url: 'https://files.pythonhosted.org/packages/39/66/2313497fdbc7fbadf8e026c09366e3f049f9114e65ca4edc23cdb8699186/mlx_metal-0.31.1-py3-none-macosx_14_0_arm64.whl',
  sha256: '70741174131dbf7fdd479cb730e06e08c358eac3bf7905d9e884e7960cfdd5b8'
} as const

if (process.platform !== 'darwin' || process.arch !== 'arm64') process.exit(0)

await mkdir(buildDirectory, { recursive: true })
await mkdir(outputDirectory, { recursive: true })

await new Promise<void>((resolve, reject) => {
  const child = spawn(
    '/usr/bin/swift',
    [
      'build',
      '--package-path',
      packageDirectory,
      '--scratch-path',
      buildDirectory,
      '--configuration',
      'release',
      '--product',
      'mlx-worker',
      '--jobs',
      '2'
    ],
    { stdio: 'inherit' }
  )
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`MLX worker build exited with code ${code ?? 'unknown'}.`))
  })
})

const candidates = [
  join(buildDirectory, 'arm64-apple-macosx/release/mlx-worker'),
  join(buildDirectory, 'release/mlx-worker')
]
let builtPath: string | null = null
for (const candidate of candidates) {
  try {
    if ((await stat(candidate)).isFile()) {
      builtPath = candidate
      break
    }
  } catch {
    // Try the next SwiftPM output layout.
  }
}
if (!builtPath) throw new Error('SwiftPM did not produce the MLX speech worker.')

await copyFile(builtPath, outputPath)
await chmod(outputPath, 0o755)

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

const builtMetallib = await findMetallib(metalWheelDirectory)
if (!builtMetallib) throw new Error('The verified MLX Metal wheel contained no mlx.metallib.')
await copyFile(builtMetallib, metallibPath)
