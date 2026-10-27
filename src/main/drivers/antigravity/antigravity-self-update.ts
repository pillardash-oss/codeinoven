import { existsSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Logger } from '../../system/logger'
import { resolveExecutablePathAsync } from '../cli-environment'

/**
 * Hold Antigravity's own background auto-updater so CodeInOven owns updates.
 *
 * The CLI ships a background updater that runs on every launch: about a second
 * into a session it spawns `agy --bg-updater`, fetches its release manifest and
 * replaces the binary in place. That is why the Harnesses page never offered an
 * Antigravity update: the comparison in `harness-update-service` reads a version
 * the CLI had already advanced on its own.
 *
 * agy 1.4.8 has no supported off switch. `AGY_CLI_DISABLE_AUTO_UPDATE` does not
 * reach the CLI updater (verified by pointing `agy --bg-updater` at a local
 * release server serving a newer manifest: it downloaded and applied the update
 * with that variable set), and `--release_base_url` exists only on the updater
 * subcommand CodeInOven never spawns itself. The one door the CLI does respect
 * is its own 15-minute throttle: when `last_check.timestamp` was touched within
 * the last 15 minutes the updater takes its "fast path" and never checks
 * (`Last check was less than 15 minutes ago, skipping update (fast path)`).
 * Refreshing that stamp right before CodeInOven launches the CLI keeps the
 * harness on the version CodeInOven knows about, so the Harnesses page reports
 * the real gap and updates run through the CLI's own `agy update` when the user
 * (or their auto-update preference) asks for one.
 *
 * A manual `agy update` ignores the throttle, so this never blocks an update
 * CodeInOven started.
 *
 * The stamp follows the HOME the CLI itself will run under: a managed account
 * is a HOME container, and a turn's runtime overlay HOME links the real
 * `antigravity-cli` profile directory through, so it is one file per install.
 *
 * A machine without the CLI is left completely alone: no Antigravity home is
 * created for a harness that is not installed. An install that has never run
 * yet (installed but no profile directory) does get one seeded, which is the
 * directory the CLI would create on its first launch anyway, so that first
 * launch cannot update itself either.
 */
export function antigravityAutoUpdateStampPath(environment: NodeJS.ProcessEnv = {}): string {
  const home = environment['HOME'] ?? environment['USERPROFILE'] ?? homedir()
  return join(home, '.gemini', 'antigravity-cli', 'last_check.timestamp')
}

/**
 * Refresh the CLI's own update-check stamp for this install, so its next launch
 * takes the throttled path instead of updating itself. Best effort: an install
 * CodeInOven cannot see is left alone, and a filesystem failure never blocks a
 * launch.
 */
export async function holdAntigravitySelfUpdate(
  environment: NodeJS.ProcessEnv = {}
): Promise<void> {
  const stampPath = antigravityAutoUpdateStampPath(environment)
  const profileDirectory = dirname(stampPath)
  if (!existsSync(profileDirectory)) {
    // No profile yet. Seed one only for an install that exists, so a machine
    // without Antigravity never gains an empty home it never asked for.
    if (!(await resolveExecutablePathAsync('agy', environment))) return
  }
  try {
    const now = new Date()
    if (existsSync(stampPath)) {
      await utimes(stampPath, now, now)
      return
    }
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(stampPath, '')
    await utimes(stampPath, now, now)
  } catch (error) {
    Logger.dev('Antigravity self-update hold could not be refreshed:', error)
  }
}
