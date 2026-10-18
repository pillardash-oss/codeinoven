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
 *   bun run msix:build                     validate, then build the package
 *   bun scripts/msix.ts --out dist --arch x64
 *   bun scripts/msix.ts --prepackaged dist/win-unpacked   package an app dir CI already built
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
 */
function readAppxBlock(configPath: string): string {
  const lines = readFileSync(configPath, 'utf8').split('\n')
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
 * Turn the app's own version into the four-part numeric `Identity/Version`.
 *
 * The fourth part is reserved for the Store and must be 0 in the package we
 * build, so it is always 0 here.
 */
export function toPackageVersion(appVersion: string): string {
  const parts = appVersion.split('.')
  const numbers = parts.map((part) => Number.parseInt(part, 10))
  if (numbers.length === 0 || numbers.some((value) => Number.isNaN(value))) {
    fail(`Cannot read a numeric package version from the app version \`${appVersion}\``)
  }
  while (numbers.length < 3) numbers.push(0)
  for (const value of numbers) {
    if (value < 0 || value > 65535) {
      fail(`Package version component ${value} is outside the Store's allowed range of 0 to 65535`)
    }
  }
  return `${numbers[0]}.${numbers[1]}.${numbers[2]}.0`
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, 'true')
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return flags
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

function main(): void {
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

  if (packageVersion.startsWith('0.')) {
    // The Store reserves the fourth section of the version for itself and
    // requires the first section not to be 0, so a pre-1.0 app cannot use its
    // own version verbatim. The build is allowed to continue because the
    // package is still worth producing, but this has to be seen.
    write(
      '::warning title=MSIX version::Package version starts with 0, and the Microsoft Store does not ' +
        'allow the first version section to be 0. If certification rejects this package, the Store ' +
        'version has to be supplied explicitly through `appx.customManifestPath`.'
    )
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
      // wanted, and forcing one would fail the build.
      '-c.forceCodeSigning=false',
      '-c.directories.output=' + outDir,
      // CI builds the MSIX from the app directory the ordinary Windows package
      // step already produced. electron-builder skips packaging entirely for a
      // prepackaged run, so the launcher, the fuses and the extra resources are
      // not built a second time; only the appx target runs.
      ...(prepackaged === undefined ? [] : ['--prepackaged', prepackaged])
    ],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    fail(`electron-builder exited with status ${result.status ?? 'unknown'}`)
  }

  write(`\n${APP_NAME} MSIX: look for ${APP_SLUG}-${appVersion}-${arch}.msix in ${outDir}`)
}

if (import.meta.main) {
  main()
}
