/**
 * Prepare the macOS WebAuthn signing assets from a provisioning profile.
 *
 * Electron services a Touch ID passkey only when the app's code signature grants
 * `keychain-access-groups`, and macOS honours a restricted entitlement like that
 * one only for code that also embeds the provisioning profile authorizing it.
 * Signing with the entitlement and no profile does not degrade gracefully: the
 * process is killed before it runs a line of app code, with `Code has restricted
 * entitlements, but the validation of its code signature failed.` in the system
 * log. So the profile has to be checked, and refused when it cannot authorize the
 * group, before a plist that asks for the entitlement may exist at all. That
 * refusal is the reason this script exists.
 *
 * On success it writes `build/entitlements.mac.webauthn.plist` (the existing
 * macOS entitlements plus `keychain-access-groups`) and prints the two
 * electron-builder overrides that consume it. The profile is handed to
 * electron-builder as-is and embedded by the signer, which also injects the
 * `com.apple.application-identifier` and `com.apple.developer.team-identifier`
 * entitlements that a profile requires.
 *
 * Usage:
 *   bun scripts/mac-webauthn-entitlements.ts --profile <path> --team <TEAM_ID>
 *
 * Both values may come from the environment instead:
 *   CODEINOVEN_MAC_PROVISIONING_PROFILE, CODEINOVEN_MAC_TEAM_ID (or APPLE_TEAM_ID)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP_ID } from '../src/lib/brand'
import { isAppleTeamId, webauthnKeychainAccessGroup } from '../src/lib/browser/browser-webauthn'

/** Entitlements file every macOS build already uses, kept as the base so the
 *  WebAuthn variant can only ever add to it. */
const BASE_ENTITLEMENTS = 'build/entitlements.mac.plist'
/** Generated entitlements file the WebAuthn packaging run points at. */
const WEBAUTHN_ENTITLEMENTS = 'build/entitlements.mac.webauthn.plist'
/** Where a profile is expected when neither the flag nor the environment names one. */
const EMBEDDED_PROFILE = 'build/embedded.provisionprofile'
/** Platform names a macOS provisioning profile reports. */
const MAC_PLATFORM_NAMES = ['OSX', 'macOS', 'macosx']

/** The part of a decoded provisioning profile this check reads. */
export interface ProvisioningProfileMessage {
  TeamIdentifier?: unknown
  Platform?: unknown
  ProvisionsAllDevices?: unknown
  ProvisionedDevices?: unknown
  ExpirationDate?: unknown
  Entitlements?: unknown
}

export interface ProfileVerdict {
  ok: boolean
  /** Why the profile cannot authorize the group. Empty when `ok`. */
  reason: string
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Whether `profile` authorizes WebAuthn credentials in this app's keychain
 * group, for `teamId`.
 *
 * A profile that fails any of these would either be rejected silently by the
 * signer or produce a bundle macOS refuses to launch, so every one of them is a
 * hard stop rather than a warning.
 */
export function validateWebAuthnProfile(
  profile: ProvisioningProfileMessage,
  teamId: string
): ProfileVerdict {
  if (!isAppleTeamId(teamId)) {
    return { ok: false, reason: `"${teamId}" is not a ten-character Apple team identifier` }
  }

  const teams = asStringArray(profile.TeamIdentifier)
  if (!teams.includes(teamId)) {
    return {
      ok: false,
      reason: `the profile is for team ${teams.join(', ') || '(none)'}, not ${teamId}`
    }
  }

  const platforms = asStringArray(profile.Platform)
  const declaresMacPlatform = platforms.some((name) => MAC_PLATFORM_NAMES.includes(name))
  const allDevices =
    typeof profile.ProvisionsAllDevices === 'boolean' && profile.ProvisionsAllDevices
  if (!declaresMacPlatform && !(platforms.length === 0 && allDevices)) {
    return {
      ok: false,
      reason: `the profile is not a macOS profile (Platform: ${platforms.join(', ') || '(none)'})`
    }
  }

  const expiration = profile.ExpirationDate
  if (expiration instanceof Date && expiration.getTime() <= Date.now()) {
    return { ok: false, reason: `the profile expired on ${expiration.toISOString()}` }
  }

  const entitlements = asRecord(profile.Entitlements)
  const group = webauthnKeychainAccessGroup(teamId)
  const groups = asStringArray(entitlements['keychain-access-groups'])
  if (!groups.includes(group) && !groups.includes(`${teamId}.*`)) {
    return {
      ok: false,
      reason:
        `the profile does not grant "${group}" (keychain-access-groups: ` +
        `${groups.join(', ') || '(none)'}); enable the Keychain Sharing capability on the ` +
        `${APP_ID} App ID and regenerate the profile`
    }
  }

  const applicationIdentifier = entitlements['com.apple.application-identifier']
  if (typeof applicationIdentifier === 'string') {
    const expected = `${teamId}.${APP_ID}`
    if (applicationIdentifier !== expected && applicationIdentifier !== `${teamId}.*`) {
      return {
        ok: false,
        reason:
          `the profile is issued to ${applicationIdentifier}, not ${expected}, so the ` +
          'signer cannot inject a matching application identifier'
      }
    }
  }

  return { ok: true, reason: '' }
}

/** Decode a provisioning profile with the same tool `@electron/osx-sign` uses.
 *
 * The profile carries a `DeveloperCertificates` `<data>` blob, which JSON cannot
 * represent, so the whole message is never converted at once. Each field this
 * check reads is extracted on its own instead, and a field the profile omits
 * comes back as `undefined` rather than failing the run. */
export function decodeProvisioningProfile(profilePath: string): ProvisioningProfileMessage {
  const decoded = execFileSync('security', ['cms', '-D', '-i', profilePath])

  const field = (key: string, format: 'json' | 'raw'): string | undefined => {
    try {
      return execFileSync('plutil', ['-extract', key, format, '-o', '-', '-'], {
        input: decoded,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim()
    } catch {
      return undefined
    }
  }

  const jsonField = (key: string): unknown => {
    const text = field(key, 'json')
    if (text === undefined || text.length === 0) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed
    } catch {
      return undefined
    }
  }

  const expirationText = field('ExpirationDate', 'raw')
  const expiration = expirationText ? new Date(expirationText) : undefined

  return {
    TeamIdentifier: jsonField('TeamIdentifier'),
    Platform: jsonField('Platform'),
    ProvisionsAllDevices: jsonField('ProvisionsAllDevices'),
    ProvisionedDevices: jsonField('ProvisionedDevices'),
    Entitlements: jsonField('Entitlements'),
    ...(expiration && !Number.isNaN(expiration.getTime()) ? { ExpirationDate: expiration } : {})
  }
}

/** The base entitlements plus the WebAuthn keychain group. */
export function entitlementsWithKeychainGroup(baseText: string, teamId: string): string {
  const group = webauthnKeychainAccessGroup(teamId)
  const closingTag = '</dict>'
  const closingIndex = baseText.lastIndexOf(closingTag)
  if (closingIndex === -1) {
    throw new Error(`${BASE_ENTITLEMENTS} does not contain a closing ${closingTag} tag`)
  }
  // Insert whole lines ahead of the closing tag's own line, so the new entries
  // carry the same four-space indentation as every existing key rather than
  // inheriting the closing tag's two.
  const lineStart = baseText.lastIndexOf('\n', closingIndex) + 1
  const insertion =
    '    <!-- WebAuthn credentials for the embedded browser. macOS grants this\n' +
    '         restricted entitlement only because the build also embeds the\n' +
    '         provisioning profile that authorizes it. Never add it to the base\n' +
    '         entitlements file, which every build uses. -->\n' +
    '    <key>keychain-access-groups</key>\n' +
    '    <array>\n' +
    `      <string>${group}</string>\n` +
    '    </array>\n'
  return `${baseText.slice(0, lineStart)}${insertion}${baseText.slice(lineStart)}`
}

function readArgument(name: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  if (at === -1) return ''
  return (Bun.argv[at + 1] ?? '').trim()
}

/** The profile path, from the flag, the environment, or its conventional place. */
function resolveProfilePath(): string {
  const named =
    readArgument('profile') || process.env['CODEINOVEN_MAC_PROVISIONING_PROFILE']?.trim() || ''
  const candidate = named || (existsSync(EMBEDDED_PROFILE) ? EMBEDDED_PROFILE : '')
  if (!candidate) {
    throw new Error(
      'No provisioning profile given. Pass --profile <path>, set ' +
        `CODEINOVEN_MAC_PROVISIONING_PROFILE, or place the profile at ${EMBEDDED_PROFILE}.`
    )
  }
  const absolute = resolve(candidate)
  if (!existsSync(absolute)) {
    throw new Error(`Provisioning profile not found: ${absolute}`)
  }
  if (!statSync(absolute).isFile()) {
    throw new Error(`Provisioning profile is not a file: ${absolute}`)
  }
  return absolute
}

function main(): void {
  const profilePath = resolveProfilePath()
  const teamId =
    readArgument('team') ||
    process.env['CODEINOVEN_MAC_TEAM_ID']?.trim() ||
    process.env['APPLE_TEAM_ID']?.trim() ||
    ''

  const verdict = validateWebAuthnProfile(decodeProvisioningProfile(profilePath), teamId)
  if (!verdict.ok) {
    throw new Error(
      `This provisioning profile cannot authorize WebAuthn: ${verdict.reason}. ` +
        'Refusing to write an entitlements file that would kill every packaged launch.'
    )
  }

  const basePath = resolve(BASE_ENTITLEMENTS)
  const written = entitlementsWithKeychainGroup(readFileSync(basePath, 'utf8'), teamId)
  writeFileSync(resolve(WEBAUTHN_ENTITLEMENTS), written)

  process.stdout.write(
    `Wrote ${WEBAUTHN_ENTITLEMENTS} with keychain-access-groups for ` +
      `${webauthnKeychainAccessGroup(teamId)}\n` +
      'Package with:\n' +
      `  electron-builder --mac --dir \\\n` +
      `    -c.mac.entitlements=${WEBAUTHN_ENTITLEMENTS} \\\n` +
      `    -c.mac.entitlementsInherit=${WEBAUTHN_ENTITLEMENTS} \\\n` +
      `    -c.mac.provisioningProfile=${profilePath} \\\n` +
      '    -c.mac.notarize=false\n'
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
