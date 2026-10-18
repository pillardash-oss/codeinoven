/** Restore the pinned audio decoder when dependency install scripts were skipped. */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import ffmpegPath from 'ffmpeg-static'
import { Logger } from '../src/main/system/logger'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const packageDirectory = dirname(fileURLToPath(import.meta.resolve('ffmpeg-static')))

if (!ffmpegPath) throw new Error('The pinned audio decoder does not support this platform.')

const executableExists = await access(ffmpegPath, constants.X_OK).then(
  () => true,
  () => false
)

if (!executableExists) {
  // An explicit external decoder belongs to the caller, never overwrite it.
  if (process.env.FFMPEG_BIN) {
    throw new Error('FFMPEG_BIN does not point to an executable audio decoder.')
  }
  const metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    'ffmpeg-static': { 'binary-release-tag': string }
  }
  const release =
    process.env.FFMPEG_BINARY_RELEASE || metadata['ffmpeg-static']['binary-release-tag']
  const baseUrl =
    process.env.FFMPEG_BINARIES_URL ||
    'https://github.com/eugeneware/ffmpeg-static/releases/download'
  const platform = process.env.npm_config_platform || process.platform
  const architecture = process.env.npm_config_arch || process.arch
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const scratch = join(projectRoot, '.cio/tmp/ffmpeg-binary-install', randomUUID())
  await mkdir(scratch, { recursive: true })
  Logger.dev('[ensure-ffmpeg-binary] Restoring the pinned audio decoder.')
  try {
    // Stream to scratch and publish only complete downloads. A failed transfer
    // must never leave a partial executable that the next startup accepts.
    for (const suffix of ['', '.README', '.LICENSE']) {
      const name = suffix
        ? `${platform}-${architecture}${suffix}`
        : `ffmpeg-${platform}-${architecture}.gz`
      const response = await fetch(`${baseUrl}/${release}/${name}`, {
        signal: AbortSignal.timeout(600_000)
      })
      if (!response.ok || !response.body) {
        throw new Error(`Audio decoder download failed (${response.status}): ${name}`)
      }
      const staged = join(scratch, `${executable}${suffix}`)
      if (suffix) {
        await Bun.write(staged, response)
      } else {
        const compressed = `${staged}.gz`
        await Bun.write(compressed, response)
        await pipeline(createReadStream(compressed), createGunzip(), createWriteStream(staged))
        await chmod(staged, 0o755)
      }
    }
    for (const suffix of ['.README', '.LICENSE', '']) {
      await rename(join(scratch, `${executable}${suffix}`), `${ffmpegPath}${suffix}`)
    }
    await access(ffmpegPath, constants.X_OK)
    Logger.dev('[ensure-ffmpeg-binary] Audio decoder restored.')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
