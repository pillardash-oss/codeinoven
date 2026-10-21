/**
 * Publish `@pdslng/cio-oven` to npm.
 *
 * The package ships on its own cadence, separate from the desktop app, and it is
 * useless unless three things agree: the service bundle it installs, the revision
 * that bundle reports, and the version it publishes under. This script owns that
 * whole sequence so no manual step can skip one of them:
 *
 *   bun run build              the app build that produces out/main/oven-service.mjs
 *   bun run oven:version:bump  the published version (patch bump)
 *   bun run oven:cli:build     dist/cli.mjs and dist/service.mjs from that bundle
 *   npm pack --dry-run         the tarball contents, verified before publishing
 *   npm publish                the registry write
 *   registry poll              proof the version is served, or how to approve it
 *
 * Refusals are deliberate: a dirty tree in the paths that shape the package, an
 * unauthenticated npm, or a version that already exists stops the run before
 * anything is written to the registry. Staged publishing (npm defers the 2FA
 * proof for granular tokens) is reported with the exact approve command instead
 * of being reported as success.
 *
 * Flags: --version <x.y.z>, --no-bump, --dry-run, --skip-build, --otp <code>,
 * --no-commit, --allow-dirty, --help.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { incrementVersion } from './bump-version'

const PACKAGE_NAME = '@pdslng/cio-oven'
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** Files the tarball cannot ship without, checked against `npm pack --dry-run`. */
const REQUIRED_TARBALL_ENTRIES = [
  'package.json',
  'README.md',
  'LICENSE',
  'bin/cio-oven.mjs',
  'dist/cli.mjs',
  'dist/service.mjs'
]
/** Paths whose uncommitted changes would make the published package differ from the repo. */
const RELEASE_PATHS = [
  'package.json',
  'packages/cio-oven',
  'scripts',
  'src/lib/ovens.ts',
  'src/main/ovens'
]
/** How long to wait for the registry to serve the version before reporting the delay. */
const VERIFY_ATTEMPTS = 60
const VERIFY_INTERVAL_MS = 5_000

const repoRoot = join(import.meta.dirname, '..')
const packageRoot = join(repoRoot, 'packages', 'cio-oven')
const bundleFile = join(repoRoot, 'out', 'main', 'oven-service.mjs')
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

interface Options {
  version: string | null
  bump: boolean
  dryRun: boolean
  skipBuild: boolean
  otp: string | null
  commit: boolean
  allowDirty: boolean
  help: boolean
}

interface RunOptions {
  cwd?: string
  echo?: boolean
  allowFailure?: boolean
}

interface RunResult {
  status: number
  output: string
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function step(message: string): void {
  process.stdout.write(`\n${message}\n`)
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    version: null,
    bump: true,
    dryRun: false,
    skipBuild: false,
    otp: null,
    commit: true,
    allowDirty: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--version': {
        const value = argv[index + 1]
        if (!value) fail('--version needs a value, as in --version 0.5.66')
        options.version = value
        index += 1
        break
      }
      case '--no-bump':
        options.bump = false
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--skip-build':
        options.skipBuild = true
        break
      case '--otp': {
        const value = argv[index + 1]
        if (!value) fail('--otp needs the one-time code from your authenticator')
        options.otp = value
        index += 1
        break
      }
      case '--no-commit':
        options.commit = false
        break
      case '--allow-dirty':
        options.allowDirty = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        fail(`Unknown argument "${argument ?? ''}". Run with --help for the flags.`)
    }
  }
  return options
}

function usage(): string {
  return [
    'Publish the Oven CLI to npm.',
    '',
    '  bun run oven:cli:publish [flags]',
    '',
    'Flags:',
    '  --version <x.y.z>  Publish this exact version instead of bumping the patch.',
    '  --no-bump          Publish the version already in the manifest (retry path).',
    '  --dry-run          Build, bump nothing, and inspect the tarball without publishing.',
    '  --skip-build       Reuse the existing out/main/oven-service.mjs instead of rebuilding.',
    '  --otp <code>       Forward a one-time code to npm, for an account without 2FA bypass.',
    '  --no-commit        Leave the version bump uncommitted.',
    '  --allow-dirty      Publish even with uncommitted changes in the release paths.',
    '  --help, -h         Print this text.'
  ].join('\n')
}

function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    // npm is a shell script on POSIX and a .cmd on Windows; neither is executed
    // directly there, so both go through the shell.
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const status = result.status ?? 1
  if (options.echo && output) process.stdout.write(`${output}\n`)
  if (status !== 0 && !options.allowFailure)
    fail(output || `${command} ${args.join(' ')} exited with code ${status}`)
  return { status, output }
}

/** Uncommitted, tracked changes inside the paths that shape the published package. */
function releaseChanges(): string[] {
  const result = run('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    ...RELEASE_PATHS
  ])
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function manifestVersion(text: string): string {
  const match = /"version"\s*:\s*"([^"]+)"/u.exec(text)
  if (!match?.[1]) throw new TypeError('packages/cio-oven/package.json has no version field.')
  return match[1]
}

async function readManifest(): Promise<string> {
  return readFile(join(packageRoot, 'package.json'), 'utf8')
}

async function writeManifestVersion(version: string): Promise<void> {
  const path = join(packageRoot, 'package.json')
  const text = await readFile(path, 'utf8')
  const current = manifestVersion(text)
  if (current === version) return
  const occurrences = [...text.matchAll(/"version"\s*:\s*"[^"]+"/gu)]
  if (occurrences.length !== 1)
    throw new Error('Expected packages/cio-oven/package.json to contain exactly one version field.')
  await writeFile(path, text.replace(occurrences[0][0], `"version": "${version}"`), 'utf8')
}

/** The npm account this run publishes as, or a refusal that says how to fix it. */
function npmIdentity(): string {
  const account = npmIdentityOrNull()
  if (!account)
    fail(
      'npm is not authenticated on this machine, so nothing can be published.\n' +
        `Log in as an account that owns the scope, then run this again:\n\n  npm login --registry=https://registry.npmjs.org/`
    )
  return account
}

function npmIdentityOrNull(): string | null {
  const result = run(npmBin, ['whoami'], { allowFailure: true })
  if (result.status !== 0) return null
  return result.output.split('\n').pop() ?? null
}

/** Whether the registry already serves a version, which makes publishing pointless. */
function versionExists(version: string): boolean {
  const result = run(npmBin, ['view', `${PACKAGE_NAME}@${version}`, 'version'], {
    allowFailure: true
  })
  return result.status === 0 && result.output.trim() === version
}

function buildApp(): void {
  step('Building the app, which produces the Oven service bundle.')
  run('bun', ['run', 'build'], { echo: true })
  if (!existsBundle()) fail(`The Oven service bundle is missing at ${bundleFile} after the build.`)
}

function existsBundle(): boolean {
  return existsSync(bundleFile)
}

function bumpVersion(): void {
  step('Bumping the published version.')
  run('bun', ['scripts/bump-oven-cli-version.ts'], { echo: true })
}

function buildCli(): void {
  step('Building the CLI package.')
  run('bun', ['scripts/build-oven-cli.ts'], { echo: true })
}

interface PackEntry {
  path: string
}

/** The tarball npm would publish, checked for the files the CLI cannot work without. */
function verifyTarball(): { files: string[]; size: number } {
  step('Inspecting the tarball npm would publish.')
  const result = run(npmBin, ['pack', '--dry-run', '--json'], { cwd: packageRoot })
  const start = result.output.indexOf('[')
  const end = result.output.lastIndexOf(']')
  if (start < 0 || end < start) fail('npm pack did not report the tarball contents.')
  let parsed: unknown
  try {
    parsed = JSON.parse(result.output.slice(start, end + 1))
  } catch {
    fail('npm pack reported tarball contents that are not JSON.')
  }
  const entries: PackEntry[] = Array.isArray(parsed)
    ? parsed.flatMap((item) => {
        const files = (item as { files?: unknown }).files
        if (!Array.isArray(files)) return []
        return files.flatMap((file) => {
          const path = (file as { path?: unknown }).path
          return typeof path === 'string' ? [{ path }] : []
        })
      })
    : []
  const files = entries.map((entry) => entry.path)
  const missing = REQUIRED_TARBALL_ENTRIES.filter((required) => !files.includes(required))
  if (missing.length) fail(`The tarball is missing ${missing.join(', ')}.`)
  const sources = files.filter((file) => file.startsWith('src/'))
  if (sources.length) fail(`The tarball ships source files it should not: ${sources.join(', ')}.`)
  const bytes = Array.isArray(parsed) ? Number((parsed[0] as { size?: unknown }).size ?? 0) : 0
  return { files, size: bytes }
}

function publish(version: string, otp: string | null): void {
  step(`Publishing ${PACKAGE_NAME}@${version}.`)
  const args = ['publish', '--access', 'public']
  if (otp) args.push('--otp', otp)
  const result = run(npmBin, args, { cwd: packageRoot, echo: true, allowFailure: true })
  if (result.status === 0) return
  // npm defers the 2FA proof for granular tokens, so a refused second attempt
  // means the version is sitting in staging rather than that anything failed.
  if (/previously staged version|being processed/u.test(result.output)) reportStaged(version)
  fail(result.output || `npm publish exited with code ${result.status}`)
}

async function waitForVersion(version: string): Promise<boolean> {
  step(`Waiting for the registry to serve ${version}.`)
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    if (versionExists(version)) return true
    if (attempt < VERIFY_ATTEMPTS)
      await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS))
  }
  return false
}

interface StagedVersion {
  id: string
  name: string
  version: string
}

/** Staged versions npm is holding for a 2FA proof, as far as this account can see them. */
function stagedVersions(): StagedVersion[] {
  const result = run(npmBin, ['stage', 'list', '--json'], { allowFailure: true })
  if (result.status !== 0) return []
  const start = result.output.indexOf('[')
  const end = result.output.lastIndexOf(']')
  if (start < 0 || end < start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(result.output.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    const id = (item as { id?: unknown }).id
    const name = (item as { name?: unknown }).name
    const version = (item as { version?: unknown }).version
    if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string') return []
    return [{ id, name, version }]
  })
}

/**
 * Report a release the registry accepted but has not served yet.
 *
 * Staging is a different state and is reported by `publish` itself, from npm's
 * own refusal. This is the ordinary case of npm still processing a release, so
 * it does not fail the run: the version bump and the release are real, and the
 * command to confirm it is printed here.
 */
function reportServingDelay(version: string): void {
  const staged = stagedVersions().find(
    (entry) => entry.name === PACKAGE_NAME && entry.version === version
  )
  process.stderr.write(
    `\nThe registry has not served ${PACKAGE_NAME}@${version} yet. npm accepted the publish, so this is usually its own processing delay.\n`
  )
  if (staged)
    process.stderr.write(
      `It is staged for a two-factor proof:\n\n  npm stage approve ${staged.id} --otp <code>\n`
    )
  else
    process.stderr.write(
      `Confirm it with:\n\n  npm view ${PACKAGE_NAME}@${version} version\n\nIf that stays empty, the release is waiting for approval at https://www.npmjs.com/package/${PACKAGE_NAME}.\n`
    )
}

function reportStaged(version: string): never {
  const match = stagedVersions().find(
    (entry) => entry.name === PACKAGE_NAME && entry.version === version
  )
  process.stderr.write(
    `\n${PACKAGE_NAME}@${version} is not served by the registry yet, and npm reports that the publish was staged.\n`
  )
  if (match)
    process.stderr.write(
      `Approve it with your one-time code:\n\n  npm stage approve ${match.id} --otp <code>\n`
    )
  else
    process.stderr.write(
      'This account cannot see the staged entry, so the scope owner has to approve it at ' +
        `https://www.npmjs.com/package/${PACKAGE_NAME} (or publish with an account that owns the scope).\n`
    )
  process.exit(1)
}

function commitVersion(version: string): void {
  step('Committing the published version.')
  run('git', ['add', 'packages/cio-oven/package.json'], { echo: true })
  run(
    'git',
    [
      'commit',
      '-m',
      `chore(release): ${PACKAGE_NAME} ${version}`,
      '--',
      'packages/cio-oven/package.json'
    ],
    { echo: true }
  )
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const changes = releaseChanges()
  if (changes.length && !options.allowDirty)
    fail(
      `Uncommitted changes would be published without a matching commit:\n  ${changes.join('\n  ')}\nCommit them first, or pass --allow-dirty.`
    )

  if (options.version && !VERSION_PATTERN.test(options.version))
    fail(`--version must be a stable major.minor.patch version, not "${options.version}".`)

  const account = options.dryRun ? npmIdentityOrNull() : npmIdentity()
  step(
    account
      ? `Publishing as ${account}.`
      : 'npm is not authenticated here, which a dry run does not need.'
  )

  const current = manifestVersion(await readManifest())
  let version = options.version ?? (options.bump ? incrementVersion(current) : current)
  if (versionExists(version))
    fail(
      `${PACKAGE_NAME}@${version} already exists on npm. Bump the version, or approve the staged copy with npm stage approve.`
    )
  step(`Target version: ${version} (manifest currently says ${current}).`)

  if (!options.skipBuild) buildApp()
  else if (!existsBundle())
    fail(`--skip-build was given but ${bundleFile} does not exist. Run bun run build first.`)

  if (!options.dryRun) {
    if (options.version && options.bump) await writeManifestVersion(version)
    else if (!options.version && options.bump) {
      bumpVersion()
      version = manifestVersion(await readManifest())
    }
  }

  buildCli()
  const tarball = verifyTarball()
  step(
    `Tarball is ready: ${version}, ${tarball.files.length} files (${tarball.files.join(', ')}), ${Math.round(tarball.size / 1024)} kB.`
  )

  if (options.dryRun) {
    step(`Dry run: ${PACKAGE_NAME}@${version} was not published.`)
    return
  }

  publish(version, options.otp)
  // npm returning 0 means the registry accepted the release; serving it is a
  // separate, slower step and is not part of whether this release exists. A
  // 120 s window reported a finished publish as a staged one, which sent the
  // release into a search for an approval that was never needed.
  if (!(await waitForVersion(version))) reportServingDelay(version)
  if (options.commit) commitVersion(version)
  step(`Published ${PACKAGE_NAME}@${version}: npx ${PACKAGE_NAME}@${version} start`)
}

await main()
