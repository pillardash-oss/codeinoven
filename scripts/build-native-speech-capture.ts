import { chmod, copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const packageDirectory = join(projectRoot, 'resources/speech/native-capture-src')
const buildDirectory = join(projectRoot, '.cio/tmp/native-speech-capture-build')
const outputDirectory = join(projectRoot, 'resources/speech/runtime/darwin-arm64')
const outputPath = join(outputDirectory, 'speech-capture-worker')
const sourcePaths = [
  join(packageDirectory, 'Package.swift'),
  join(packageDirectory, 'Sources/SpeechCaptureWorker/main.swift')
]

if (process.platform !== 'darwin' || process.arch !== 'arm64') process.exit(0)

const outputStat = await stat(outputPath).catch(() => null)
const sourceStats = await Promise.all(sourcePaths.map((path) => stat(path)))
const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs))
if (outputStat?.isFile() && outputStat.mtimeMs >= newestSource) process.exit(0)

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
      'speech-capture-worker',
      '--jobs',
      '2'
    ],
    { stdio: 'inherit' }
  )
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code === 0) resolve()
    else
      reject(new Error(`Native speech capture worker build exited with code ${code ?? 'unknown'}.`))
  })
})

const candidates = [
  join(buildDirectory, 'arm64-apple-macosx/release/speech-capture-worker'),
  join(buildDirectory, 'release/speech-capture-worker')
]
let builtPath: string | null = null
for (const candidate of candidates) {
  if ((await stat(candidate).catch(() => null))?.isFile()) {
    builtPath = candidate
    break
  }
}
if (!builtPath) throw new Error('SwiftPM did not produce the native speech capture worker.')

await copyFile(builtPath, outputPath)
await chmod(outputPath, 0o755)
