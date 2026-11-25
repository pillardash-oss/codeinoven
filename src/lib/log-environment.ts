import { APP_NAME } from './brand'

/**
 * The build and host facts the durable `Logger` stamps on every record, shared
 * so the renderer's Exceptions panel names a failure with the exact same facts
 * the log file carries instead of resolving a second, drifting copy.
 *
 * The main-process logger owns the values; the renderer only formats the answer
 * it is handed.
 */
export interface LogEnvironment {
  /** Running app version, prerelease suffix intact (`0.5.70-nightly.15`). */
  appVersion: string
  platform: string
  /** User-facing OS version, e.g. `15.5.0` on macOS, not the Darwin kernel. */
  platformVersion: string
  architecture: string
  electronVersion?: string
}

/** The OS name a reader knows, never the Node platform identifier. */
export function logPlatformName(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/**
 * One line naming the build and host a diagnostic came from.
 *
 * A stack trace alone cannot be acted on: the same frames mean different things
 * on a nightly beside a stable build, or on another OS and CPU, so the line is
 * what turns a trace into a report.
 *
 * `CodeInOven 0.5.72-nightly.3 (dev) · macOS 15.4.1 · arm64 · Electron 43.2.0`
 *
 * `buildLabel` names a checkout or a probe, and stays absent on a shipped build.
 */
export function formatLogEnvironment(
  environment: LogEnvironment,
  buildLabel?: string | null
): string {
  const os = `${logPlatformName(environment.platform)} ${environment.platformVersion}`.trim()
  return [
    `${APP_NAME} ${environment.appVersion}${buildLabel ? ` (${buildLabel})` : ''}`,
    os,
    environment.architecture,
    environment.electronVersion ? `Electron ${environment.electronVersion}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}
