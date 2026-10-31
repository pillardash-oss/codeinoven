#!/usr/bin/env bun
/**
 * Build the Microsoft Store (MSIX) package.
 *
 * This is the only supported way to produce the Store package, because the two
 * values electron-builder cannot invent, `appx.identityName` and
 * `appx.publisher`, have to be the exact strings Partner Center assigns. Getting
 * them wrong does not fail the build: electron-builder falls back to the
 * package.json `name` for a missing identity name, and substitutes `CN=ms` for a
 * missing publisher on an unsigned appx build
 * (`app-builder-lib/out/codeSign/windowsSignToolManager.js`, `computePublisherName`).
 * Either way you would ship a package with the wrong identity and only find out
 * when certification rejects it. So the values are validated here first, and the
 * package is only built when they are real.
 *
 * The values live in `electron-builder.yml` rather than being passed on the
 * command line on purpose. electron-builder's CLI reads `-c.key=value` through
 * yargs, and an X.500 publisher (`CN=..., O=..., C=...`) is a comma-separated
 * string, which yargs is willing to read as an array. Keeping the identity in
 * the config file removes that whole failure mode, and it keeps the identity
 * that a submitted package carries under version control where it can be
 * audited.
 *
 * Usage (from the repository root):
 *   bun run msix:check                     validate without building
 *   bun run msix:build                     validate, build, then verify what was built
 *   bun scripts/msix.ts --out dist --arch x64
 *   bun scripts/msix.ts --prepackaged dist/win-unpacked   package an app dir CI already built
 *   bun scripts/msix.ts --verify-only dist/codeinoven-1.5.65-x64.msix   inspect an existing package
 *
 * The package is built unsigned on purpose, and that has to hold even when the
 * caller exports signing credentials for the installer it built first. The
 * release Windows leg builds the NSIS installer from the same shell, so it
 * carries `CSC_LINK` / `CSC_KEY_PASSWORD` in the environment; electron-builder
 * picks those up for the appx target too (`getCscLink("WIN_CSC_LINK")` falls back
 * to `CSC_LINK`), and the first stable release that shipped an MSIX failed on
 * exactly that: signtool refused the Apple Developer ID certificate for an
 * AppX signature with "The specified algorithm cannot be used or is invalid".
 * The Store re-signs the package anyway, so a local certificate is neither
 * needed nor wanted. `buildEnvironment` therefore removes every signing
 * credential from the child environment.
 *
 * `-c.forceCodeSigning=false` alone is not enough: it only makes a *missing*
 * certificate acceptable, it does not stop electron-builder from using one it
 * finds.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, APP_SLUG } from '../src/lib/brand'

/** Where the appx target looks for its user assets (electron-builder's APPX_ASSETS_DIR_NAME). */
const ASSETS_DIRECTORY = 'build/appx'

/**
 * Logo files the generated manifest references by name.
 *
 * The wide tile is in this list even though the schema marks `DefaultTile`
 * optional: electron-builder's appx template always emits a `Wide310x150Logo`
 * attribute, so a missing file here means the manifest points at a nonexistent
 * asset.
 */
const REQUIRED_ASSETS: readonly string[] = [
  'StoreLogo.png',
  'Square44x44Logo.png',
  'Square150x150Logo.png',
  'Wide310x150Logo.png'
]

/** Values that mean "the app name has not been reserved in Partner Center yet". */
const PLACEHOLDER_PREFIX = 'REPLACE_WITH'

/** The publisher electron-builder silently invents when none is configured. */
const INVENTED_PUBLISHER = 'CN=ms'

type AppxIdentity = {
  identityName: string
  publisher: string
  applicationId: string
  displayName: string
  languages: string[]
}

type Check = { ok: true } | { ok: false; reason: string }

/**
 * Every environment variable electron-builder reads a code-signing certificate
 * from (see `platformPackager.getCscLink` / `getCscPassword` and
 * `windowsSignToolManager`).
 *
 * The platform-specific names are listed too: `WIN_CSC_LINK` and
 * `WIN_CSC_KEY_PASSWORD` take precedence over the generic ones, so scrubbing
 * `CSC_*` alone would leave a Windows certificate usable and sign the package
 * with it. `CSC_IDENTITY_AUTO_DISCOVERY=false` is the switch that stops macOS
 * builds from discovering an identity in the keychain.
 */
const SIGNING_ENVIRONMENT: readonly string[] = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD'
]

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  write(`::error::${message}`)
  process.exit(1)
}

/**
 * Read the `appx` block of `electron-builder.yml` as raw text.
 *
 * A YAML library would be the obvious tool, but `yaml` is only a transitive
 * dependency here (it arrives with the Pi harness), and the two values we need
 * are plain scalars whose spelling we control. Scoping the scan to the `appx`
 * block, and demanding exactly one match per key, keeps this honest: anything
 * unexpected is a hard failure rather than a silently wrong identity.
 *
 * Line endings are normalised on read. A Windows checkout of this repository has
 * CRLF endings (Git for Windows defaults to `core.autocrlf=true`), and the first
 * Windows run of this script failed on it: `readLanguages` expects a bare LF
 * after `languages:`, so the list looked missing on CI while passing locally.
 */
function readAppxBlock(configPath: string): string {
  const lines = readFileSync(configPath, 'utf8').replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((line) => /^appx:\s*$/.test(line))
  if (start === -1) fail(`No top-level \`appx:\` block in ${configPath}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.length > 0 && !/^\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Pull one `  key: value` scalar out of the appx block, unquoting it. */
function readScalar(block: string, key: string, configPath: string): string {
  const matches = [...block.matchAll(new RegExp(`^\\s+${key}:[ \\t]*(.+?)[ \\t]*$`, 'gm'))]
  if (matches.length !== 1) {
    fail(
      `Expected exactly one \`${key}\` in the appx block of ${configPath}, found ${matches.length}`
    )
  }
  const raw = matches[0]?.[1] ?? ''
  const quoted = /^(['"])(.*)\1$/.exec(raw)
  const value = (quoted ? quoted[2] : raw) ?? ''
  if (value.length === 0) fail(`\`${key}\` in ${configPath} is empty`)
  return value
}

/** The list under `  languages:` in the appx block, as bare `- value` entries. */
function readLanguages(block: string, configPath: string): string[] {
  const match = /^\s+languages:[ \t]*\n((?:\s+-[ \t]*.+\n?)+)/m.exec(block)
  if (match === null) fail(`No \`languages\` list in the appx block of ${configPath}`)
  const languages = (match[1] ?? '')
    .split('\n')
    .map((line) => /^\s+-[ \t]*(.+?)[ \t]*$/.exec(line)?.[1] ?? '')
    .filter((value) => value.length > 0)
  if (languages.length === 0) fail(`\`languages\` in ${configPath} is empty`)
  return languages
}

function readAppxIdentity(configPath: string): AppxIdentity {
  const block = readAppxBlock(configPath)
  return {
    identityName: readScalar(block, 'identityName', configPath),
    publisher: readScalar(block, 'publisher', configPath),
    applicationId: readScalar(block, 'applicationId', configPath),
    displayName: readScalar(block, 'displayName', configPath),
    languages: readLanguages(block, configPath)
  }
}

/**
 * Validate `Identity/Name`.
 *
 * Mirrors electron-builder's own rule (`AppxTarget.writeManifest`) rather than
 * inventing one, so a value that passes here cannot fail there.
 */
export function checkIdentityName(value: string): Check {
  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    return {
      ok: false,
      reason: `still a placeholder (${value}). Copy "Package/Identity/Name" from Partner Center, Product management > Product identity.`
    }
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(value)) {
    return { ok: false, reason: 'may contain only letters, digits, periods and dashes' }
  }
  if (value.length < 3 || value.length > 50) {
    return { ok: false, reason: `must be 3 to 50 characters, got ${value.length}` }
  }
  return { ok: true }
}

/**
 * Validate `Identity/Publisher`.
 *
 * Windows requires this to equal the publisher subject of the signing
 * certificate, and the Store re-signs the package with its own, so for a Store
 * submission it must equal the Partner Center value byte for byte. The check is
 * deliberately about shape (a distinguished name starting with `CN=`) rather
 * than about content, because only Partner Center knows the content.
 */
export function checkPublisher(value: string): Check {
  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    return {
      ok: false,
      reason: `still a placeholder (${value}). Copy "Package/Identity/Publisher" from Partner Center, Product management > Product identity.`
    }
  }
  if (value === INVENTED_PUBLISHER) {
    return {
      ok: false,
      reason: `is ${INVENTED_PUBLISHER}, the value electron-builder invents for an unsigned appx build. A Store package needs the real publisher subject.`
    }
  }
  if (!value.startsWith('CN=')) {
    return { ok: false, reason: 'must be a distinguished name beginning with CN=' }
  }
  return { ok: true }
}

/**
 * Offset added to the app's major version to form the Store package version.
 *
 * A constant offset, rather than substituting 1 for a pre-1.0 major, is what
 * keeps the mapping increasing across the 1.0 boundary; see `toPackageVersion`.
 */
const STORE_MAJOR_OFFSET = 1

/**
 * Turn the app's own version into the four-part numeric `Identity/Version`.
 *
 * The Store reserves the fourth section for itself and requires it to be 0 in
 * the package we build, and it does not allow the first section to be 0 either:
 * "the other sections must be set to an integer between 0 and 65535 (except for
 * the first section, which cannot be 0)"
 * (learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements).
 * Our app is pre-1.0, so its own version cannot be used verbatim: `0.5.65`
 * would become `0.5.65.0` and be rejected.
 *
 * So the major section is the app's major plus one: `0.5.65` publishes as
 * `1.5.65.0` and `1.0.0` publishes as `2.0.0.0`. Adding a constant, instead of
 * mapping a 0 major to 1 and leaving the rest alone, is deliberate. The Store
 * hands each device the highest applicable version, so a mapping that dropped
 * at 1.0 (from `1.5.x` back to `1.0.x`) would stop updating everyone who
 * installed the app before 1.0.
 */
export function toPackageVersion(appVersion: string): string {
  // Prerelease and build metadata are not part of a package version.
  const [numeric = ''] = appVersion.split(/[-+]/)
  const parts = numeric.split('.').slice(0, 3)
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN))
  if (numbers.length === 0 || numbers.some((value) => Number.isNaN(value))) {
    fail(`Cannot read a numeric package version from the app version \`${appVersion}\``)
  }
  while (numbers.length < 3) numbers.push(0)
  const [appMajor = 0, minor = 0, patch = 0] = numbers
  const major = appMajor + STORE_MAJOR_OFFSET
  for (const [label, value] of [
    ['major', major],
    ['minor', minor],
    ['patch', patch]
  ] as const) {
    if (value > 65535) {
      fail(
        `Package version ${label} ${value} is outside the Store's allowed range of 0 to 65535 ` +
          `(derived from the app version \`${appVersion}\`)`
      )
    }
  }
  return `${major}.${minor}.${patch}.0`
}

/**
 * The manifest version without the Store-reserved fourth section.
 *
 * electron-builder takes `version` from package metadata and appends the
 * fourth section itself, and it validates metadata versions as semver, which
 * `1.5.65.0` is not. So the package version is injected in this form.
 */
function toMetadataVersion(packageVersion: string): string {
  return packageVersion.split('.').slice(0, 3).join('.')
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const key = argument.slice(2)
    const next = argv[index + 1]
    // The workflow passes architecture flags such as `--arch "--x64"`.
    const architectureValue = key === 'arch' && /^--(?:x64|arm64|ia32)$/.test(next ?? '')
    if (next === undefined || (next.startsWith('--') && !architectureValue)) {
      flags.set(key, 'true')
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return flags
}

/**
 * The environment the electron-builder child runs with: this process's
 * environment minus every signing credential, so an MSIX can never be signed
 * with whatever certificate the surrounding build exported.
 */
function buildEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env }
  for (const name of SIGNING_ENVIRONMENT) delete environment[name]
  // electron-builder treats this as "no identity on this machine", which is what
  // a Store package wants; it is set rather than deleted so a variable inherited
  // as `true` cannot re-enable discovery.
  environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return environment
}

function requireAssets(): void {
  const missing = REQUIRED_ASSETS.filter((name) => !existsSync(join(ASSETS_DIRECTORY, name)))
  if (missing.length > 0) {
    fail(
      `Missing MSIX assets in ${ASSETS_DIRECTORY}: ${missing.join(', ')}. ` +
        'Regenerate them with `bun scripts/build-app-icons.ts`.'
    )
  }
}

/**
/**
 * One file inside the package, located from its central directory record.
 */
type PackageEntry = {
  name: string
  method: number
  uncompressedSize: number
  compressedSize: number
  localHeaderOffset: number
}

const ZIP_END_OF_DIRECTORY = 0x06054b50
const ZIP64_END_OF_DIRECTORY = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP_DIRECTORY_ENTRY = 0x02014b50
const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP64_EXTRA_FIELD = 0x0001
const ZIP_LARGEST_COMMENT = 65_535
/** The value a 32-bit field carries when the real one lives in a ZIP64 record. */
const ZIP_32BIT_LIMIT = 0xffff_ffff

/**
 * One file inside the package, located from its central directory record.
 *
 * An MSIX is a zip container, and the package is read here rather than with the
 * host's archive tool. The first Windows run of this verification failed with
 * `tar: This does not look like a tar archive`: `tar` on a Windows runner is
 * Git's GNU tar, which does not read zip, and `unzip` is not installed there at
 * all. Reading the container in-process removes the dependency on which tools a
 * machine happens to have.
 *
 * Two things about the real package are handled here rather than assumed. The
 * backward scan for the end-of-directory record used to take the first signature
 * it met without checking that the record ended where the file ends, which read
 * a wrong record out of the first real package and ran off the end of the file
 * with `RangeError: Out of bounds access`; a candidate now has to account for
 * the whole tail. And a package is allowed to use ZIP64, which replaces the
 * 32-bit fields with 0xFFFFFFFF sentinels, so the locator, the record and the
 * per-entry extra field are all read.
 */
function readPackageDirectory(bytes: Uint8Array): PackageEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEndOfDirectory(view, bytes.length)
  if (end === null) fail('The package is not a readable zip container')

  let count = view.getUint16(end + 10, true)
  let directoryOffset = view.getUint32(end + 16, true)
  if (count === 0xffff || directoryOffset === ZIP_32BIT_LIMIT) {
    const locator = end - 20
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) {
      fail('The package needs a ZIP64 record and has no readable locator')
    }
    const record = Number(view.getBigUint64(locator + 8, true))
    if (record < 0 || record + 56 > bytes.length) {
      fail('The package ZIP64 record is outside the file')
    }
    if (view.getUint32(record, true) !== ZIP64_END_OF_DIRECTORY) {
      fail('The package ZIP64 record is unreadable')
    }
    count = Number(view.getBigUint64(record + 32, true))
    directoryOffset = Number(view.getBigUint64(record + 48, true))
  }

  const decoder = new TextDecoder()
  const entries: PackageEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== ZIP_DIRECTORY_ENTRY) {
      fail(`The package central directory is unreadable at entry ${index} of ${count}`)
    }
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const extraStart = cursor + 46 + nameLength
    const extra = readZip64Extra(
      view,
      extraStart,
      extraLength,
      view.getUint32(cursor + 24, true),
      view.getUint32(cursor + 20, true),
      view.getUint32(cursor + 42, true)
    )
    entries.push({
      name: decoder.decode(bytes.subarray(cursor + 46, extraStart)),
      method: view.getUint16(cursor + 10, true),
      uncompressedSize: extra.uncompressedSize,
      compressedSize: extra.compressedSize,
      localHeaderOffset: extra.localHeaderOffset
    })
    cursor = extraStart + extraLength + commentLength
  }
  return entries
}

/**
 * The last valid end-of-directory record.
 *
 * A candidate has to end where the file ends, comment length included, so a
 * stray signature inside compressed data cannot be mistaken for it.
 */
function findEndOfDirectory(view: DataView, length: number): number | null {
  const earliest = Math.max(0, length - ZIP_LARGEST_COMMENT - 22)
  for (let offset = length - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_DIRECTORY) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + 22 + commentLength === length) return offset
  }
  return null
}

/** The 32-bit sizes and offset, replaced by their ZIP64 extra-field values when set. */
function readZip64Extra(
  view: DataView,
  start: number,
  length: number,
  uncompressedSize: number,
  compressedSize: number,
  localHeaderOffset: number
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  const result = { uncompressedSize, compressedSize, localHeaderOffset }
  if (
    uncompressedSize !== ZIP_32BIT_LIMIT &&
    compressedSize !== ZIP_32BIT_LIMIT &&
    localHeaderOffset !== ZIP_32BIT_LIMIT
  ) {
    return result
  }
  let cursor = start
  const limit = start + length
  while (cursor + 4 <= limit) {
    const id = view.getUint16(cursor, true)
    const fieldLength = view.getUint16(cursor + 2, true)
    if (id === ZIP64_EXTRA_FIELD) {
      let field = cursor + 4
      const fieldEnd = field + fieldLength
      if (uncompressedSize === ZIP_32BIT_LIMIT && field + 8 <= fieldEnd) {
        result.uncompressedSize = Number(view.getBigUint64(field, true))
        field += 8
      }
      if (compressedSize === ZIP_32BIT_LIMIT && field + 8 <= fieldEnd) {
        result.compressedSize = Number(view.getBigUint64(field, true))
        field += 8
      }
      if (localHeaderOffset === ZIP_32BIT_LIMIT && field + 8 <= fieldEnd) {
        result.localHeaderOffset = Number(view.getBigUint64(field, true))
      }
      return result
    }
    cursor += 4 + fieldLength
  }
  return result
}

async function readPackageEntry(bytes: Uint8Array, entry: PackageEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_HEADER) {
    fail(`The package entry \`${entry.name}\` has no readable local header`)
  }
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true)
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true)
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength
  // Copied into its own buffer: the view type of a subarray is not a `BlobPart`
  // under this project's TypeScript settings.
  const compressed = new Uint8Array(entry.compressedSize)
  compressed.set(bytes.subarray(start, start + entry.compressedSize))
  // 0 is stored, 8 is deflate, which is what `makeappx` writes unless the build
  // asks for store compression.
  if (entry.method === 0) return compressed
  if (entry.method !== 8) fail(`Unsupported compression method ${entry.method} in the package`)
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One attribute of the manifest's `<Identity>` element. */
function readIdentityAttribute(manifest: string, attribute: string): string {
  const element = /<Identity\b[^>]*>/.exec(manifest)?.[0]
  if (element === undefined) fail('The package manifest has no <Identity> element')
  const value = new RegExp(`\\b${attribute}\\s*=\\s*("|')(.*?)\\1`).exec(element)?.[2]
  if (value === undefined || value.length === 0) {
    fail(`The package manifest's <Identity> element has no \`${attribute}\` attribute`)
  }
  return value
}

/**
 * Inspect a built package and assert the things certification checks first.
 *
 * The appx target only runs on Windows and shells out to `makeappx.exe`, so the
 * first build of every change happens in CI; this reads the artifact back from
 * the outside instead of trusting that the manifest came out right. It asserts
 * the identity the Store matches byte for byte, the version rules the Store
 * enforces, and that the executable and tile assets the manifest names are
 * actually in the package.
 */
async function verifyPackage(
  msixPath: string,
  identity: AppxIdentity,
  packageVersion: string,
  arch: string
): Promise<void> {
  if (!existsSync(msixPath)) fail(`No package at ${msixPath}`)
  const bytes = new Uint8Array(await Bun.file(msixPath).arrayBuffer())
  const directory = readPackageDirectory(bytes)
  const manifestEntry = directory.find((entry) => entry.name.toLowerCase() === 'appxmanifest.xml')
  if (manifestEntry === undefined) fail(`The package at ${msixPath} has no AppxManifest.xml`)
  const manifest = new TextDecoder().decode(await readPackageEntry(bytes, manifestEntry))
  const entries = directory.map((entry) => entry.name.replace(/\\/g, '/'))

  const checks: ReadonlyArray<readonly [string, string, string]> = [
    ['Identity Name', readIdentityAttribute(manifest, 'Name'), identity.identityName],
    ['Identity Publisher', readIdentityAttribute(manifest, 'Publisher'), identity.publisher],
    ['Identity Version', readIdentityAttribute(manifest, 'Version'), packageVersion],
    [
      'Identity ProcessorArchitecture',
      readIdentityAttribute(manifest, 'ProcessorArchitecture'),
      arch
    ]
  ]
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail(`${label} is \`${actual}\` in the package but \`${expected}\` is expected`)
    }
    write(`  ${label} = ${actual}`)
  }

  const executable = /<Application\b[^>]*\bExecutable\s*=\s*("|')(.*?)\1/.exec(manifest)?.[2]
  if (executable === undefined) fail('The package manifest has no <Application> executable')
  const required = [
    executable.replace(/\\/g, '/'),
    ...REQUIRED_ASSETS.map((name) => `assets/${name}`)
  ]
  const present = new Set(entries.map((entry) => entry.toLowerCase()))
  const missing = required.filter((entry) => !present.has(entry.toLowerCase()))
  if (missing.length > 0) {
    fail(`The package manifest names files that are not in the package: ${missing.join(', ')}`)
  }
  write(`  executable = ${executable} (present)`)
  write(`  tile assets = ${REQUIRED_ASSETS.length} present`)
  write(`  files = ${entries.length}`)
  write(`Package verified: ${msixPath}`)
}

/** The package this run would have produced, for verification. */
function expectedArtifactPath(outDir: string, packageVersion: string, arch: string): string {
  return join(outDir, `${APP_SLUG}-${toMetadataVersion(packageVersion)}-${arch}.msix`)
}

async function writePackageVerification(
  msixPath: string,
  identity: AppxIdentity,
  packageVersion: string,
  arch: string
): Promise<void> {
  write(`\nVerifying ${msixPath}`)
  await verifyPackage(msixPath, identity, packageVersion, arch)
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2))
  const configPath = flags.get('config') ?? 'electron-builder.yml'
  const outDir = flags.get('out') ?? 'dist'
  // Accepts both `x64` and the `--x64` spelling the workflow matrix carries.
  const arch = (flags.get('arch') ?? 'x64').replace(/^-+/, '')
  const prepackaged = flags.get('prepackaged')
  const checkOnly = flags.has('check')

  const identity = readAppxIdentity(configPath)
  const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
    .version
  const packageVersion = toPackageVersion(appVersion)

  for (const [label, value, check] of [
    ['appx.identityName', identity.identityName, checkIdentityName],
    ['appx.publisher', identity.publisher, checkPublisher]
  ] as const) {
    const result = check(value)
    if (!result.ok) fail(`${label} is invalid: ${result.reason}`)
    write(`${label} = ${value}`)
  }
  requireAssets()

  write(`package version   = ${packageVersion} (from app version ${appVersion})`)
  write(`applicationId     = ${identity.applicationId}`)
  write(`displayName       = ${identity.displayName}`)
  write(`languages         = ${identity.languages.join(', ')}`)

  const verifyOnly = flags.get('verify-only')
  if (verifyOnly !== undefined) {
    const target =
      verifyOnly === 'true' ? expectedArtifactPath(outDir, packageVersion, arch) : verifyOnly
    await writePackageVerification(target, identity, packageVersion, arch)
    return
  }

  if (checkOnly) {
    write('MSIX identity checks passed; nothing was built.')
    return
  }

  const result = spawnSync(
    'bunx',
    [
      'electron-builder',
      '--win',
      'appx',
      `--${arch}`,
      '--publish',
      'never',
      // The Store signs the package; a local certificate is neither required nor
      // wanted, and forcing one would fail the build. The certificate itself is
      // kept out of reach by `buildEnvironment`.
      '-c.forceCodeSigning=false',
      '-c.directories.output=' + outDir,
      // The Store's version rules are not the app's version rules while the app
      // is pre-1.0 (see `toPackageVersion`), so the package version is injected
      // as metadata for this build only. The app's own package.json keeps the
      // real version; a prepackaged run rewrites nothing on disk.
      `-c.extraMetadata.version=${toMetadataVersion(packageVersion)}`,
      // CI builds the MSIX from the app directory the ordinary Windows package
      // step already produced. electron-builder skips packaging entirely for a
      // prepackaged run, so the launcher, the fuses and the extra resources are
      // not built a second time; only the appx target runs.
      ...(prepackaged === undefined ? [] : ['--prepackaged', prepackaged])
    ],
    { stdio: 'inherit', env: buildEnvironment() }
  )
  if (result.status !== 0) {
    fail(`electron-builder exited with status ${result.status ?? 'unknown'}`)
  }

  write(`\n${APP_NAME} MSIX: ${expectedArtifactPath(outDir, packageVersion, arch)}`)

  if (flags.get('no-verify') === undefined) {
    await writePackageVerification(
      expectedArtifactPath(outDir, packageVersion, arch),
      identity,
      packageVersion,
      arch
    )
  }
}

if (import.meta.main) {
  await main()
}
