import { access, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
type ProcessWithResourcesPath = NodeJS.Process & { resourcesPath?: string }

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
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))]
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
