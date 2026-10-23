import { access, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
type ProcessWithResourcesPath = NodeJS.Process & { resourcesPath?: string }

/**
 * A path segment that points into an asar archive.
 *
 * `ffmpeg-static` exports a path built from its own `__dirname`, which inside a
 * packaged app is `.../Resources/app.asar/node_modules/ffmpeg-static`. Electron's
 * patched `fs` reads that path happily, because electron-builder keeps the
 * executable in `app.asar.unpacked` beside the archive, so an accessibility
 * check alone cannot tell the two forms apart. `child_process.spawn` gets no such
 * redirection: `app.asar` is a file, so anything spawned through it fails with
 * `ENOTDIR` before the decoder starts (a packaged app logged that for every
 * dictation, video render and playback conversion). The unpacked sibling is the
 * only form a process can execute, so it is the only form this module hands out.
 */
const ASAR_SEGMENT = /([\\/][^\\/]+\.asar)(?=[\\/])/

function unpackedSibling(candidate: string): string {
  return candidate.replace(ASAR_SEGMENT, '$1.unpacked')
}

function insideAsarArchive(candidate: string): boolean {
  return ASAR_SEGMENT.test(candidate)
}

function candidatePaths(): string[] {
  const bundledPath = typeof ffmpegStaticPath === 'string' ? ffmpegStaticPath : undefined
  const resourcesPath = (process as ProcessWithResourcesPath).resourcesPath
  const candidates = [
    bundledPath,
    bundledPath ? join(dirname(bundledPath), executableName) : undefined,
    join(process.cwd(), 'node_modules', 'ffmpeg-static', executableName),
    resourcesPath
      ? join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executableName)
      : undefined,
    resourcesPath ? join(resourcesPath, 'node_modules', 'ffmpeg-static', executableName) : undefined
  ]
  return [
    ...new Set(
      candidates
        .filter((candidate): candidate is string => Boolean(candidate))
        .map(unpackedSibling)
        .filter((candidate) => !insideAsarArchive(candidate))
    )
  ]
}

export async function resolveFfmpegPath(): Promise<string> {
  for (const candidate of candidatePaths()) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error(
    'The packaged audio decoder is unavailable. Rebuild or reinstall the application before recording.'
  )
}
