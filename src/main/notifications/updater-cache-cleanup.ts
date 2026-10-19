import { opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions } from './updater-install-recovery'
import { Logger } from '../system/logger'

const MAX_INSPECTED_FILES = 512
const MAX_REMOVED_FILES = 64

/** Only artifacts produced by this app's release naming rules are eligible. */
function artifactVersion(name: string): string | null {
  if (!/\.(?:exe|zip|dmg|AppImage|deb)(?:\.blockmap)?$/i.test(name)) return null
  const stem = name
    .replace(/\.(?:exe|zip|dmg|AppImage|deb)(?:\.blockmap)?$/i, '')
    .replace(/^(?:\d+-)?temp-/i, '')
  if (stem === name) return null
  const match = /^codeinoven-(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/i.exec(
    stem.replace(/-(?:setup|x64|arm64|ia32)$/i, '')
  )
  return match?.[1] ?? null
}

/**
 * Clean only updater-owned files, sequentially with bounded directory scans.
 * Startup removes payloads already installed; a new download keeps only its
 * own resumable payload. Unknown files, directories and symlinks are untouched.
 */
export async function cleanUpdaterCache(
  cacheDir: string,
  options: { installedVersion: string } | { downloadingFileName: string }
): Promise<void> {
  let removed = 0
  for (const directory of [cacheDir, join(cacheDir, 'pending')]) {
    let inspected = 0
    try {
      const entries = await opendir(directory)
      for await (const entry of entries) {
        if (++inspected > MAX_INSPECTED_FILES || removed >= MAX_REMOVED_FILES) break
        if (!entry.isFile()) continue
        const version = artifactVersion(entry.name)
        if (version === null) continue
        const obsolete =
          'installedVersion' in options
            ? compareVersions(version, options.installedVersion) <= 0
            : entry.name !== options.downloadingFileName &&
              entry.name !== `${options.downloadingFileName}.blockmap`
        if (!obsolete) continue
        try {
          await rm(join(directory, entry.name), { force: true })
          removed++
        } catch (error: unknown) {
          Logger.dev('Updater: cached artifact is still in use', error)
        }
      }
    } catch (error: unknown) {
      Logger.dev('Updater: cache cleanup skipped', error)
    }
  }
  if (removed > 0) Logger.dev(`Updater: removed ${removed} obsolete cached update files`)
}
