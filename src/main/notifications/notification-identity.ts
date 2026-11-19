import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Whether this build is allowed to ask macOS for notifications at all.
 *
 * `usernotificationsd` accepts a request only when the *code-signing* identifier
 * of the requesting process is the bundle identifier the request carries.
 * Anything else is treated as one app posting for another and refused
 * (`addRequest not allowed: <bundle id>`), which the app sees as
 * `UNErrorDomain error 1` on every delivery: no card, no permission prompt, and
 * no row in System Settings to switch on. A packaging mistake therefore looks
 * exactly like a user who blocked notifications, which is the one thing the
 * app must never tell them.
 */
export type NotificationIdentityVerdict =
  | { kind: 'matched' }
  | { kind: 'mismatched'; bundleIdentifier: string; signatureIdentifier: string }
  | { kind: 'unknown' }

let cachedVerdict: Promise<NotificationIdentityVerdict> | undefined

/**
 * The verdict for this process, resolved at most once.
 *
 * Only consulted after macOS has actually refused a delivery: the ordinary path
 * never spawns anything, and the answer cannot change while the process runs.
 */
export function notificationIdentityVerdict(): Promise<NotificationIdentityVerdict> {
  cachedVerdict ??= inspectIdentity()
  return cachedVerdict
}

async function inspectIdentity(): Promise<NotificationIdentityVerdict> {
  if (process.platform !== 'darwin') return { kind: 'unknown' }
  const executablePath = process.execPath
  const [bundleIdentifier, signatureIdentifier] = await Promise.all([
    readBundleIdentifier(executablePath),
    readSignatureIdentifier(executablePath)
  ])
  if (bundleIdentifier === null || signatureIdentifier === null) return { kind: 'unknown' }
  if (bundleIdentifier === signatureIdentifier) return { kind: 'matched' }
  return { kind: 'mismatched', bundleIdentifier, signatureIdentifier }
}

/** `CFBundleIdentifier` of the app bundle whose main executable lives here. */
async function readBundleIdentifier(executablePath: string): Promise<string | null> {
  // Contents/MacOS/<executable> -> Contents/Info.plist
  const plistPath = join(dirname(executablePath), '..', 'Info.plist')
  try {
    const plist = await readFile(plistPath, 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

/** The `Identifier=` value codesign reports for that executable. */
function readSignatureIdentifier(executablePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    // codesign prints its description on stderr and exits non-zero for an
    // unsigned or unreadable target, which is exactly "no identity to compare".
    execFile(
      'codesign',
      ['-d', '--verbose=2', executablePath],
      { timeout: 5_000 },
      (_error, _stdout, stderr) => {
        const match = /^Identifier=(.+)$/m.exec(stderr)
        resolve(match?.[1]?.trim() ?? null)
      }
    )
  })
}
