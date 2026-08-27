import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { app } from 'electron'
import type { HarnessExecutionTarget } from '../../lib/types'
import {
  buildProcessEnvironment,
  commandRequiresShell,
  resolveExecutablePath
} from './cli-environment'

/**
 * Base directory of the bundled Pi resource (see `scripts/build-pi-harness.ts`),
 * or `undefined` if it's missing (e.g. a dev checkout that never ran the
 * build script). Used only as a fallback when no `pi` is found on PATH or in
 * WSL — a real install always takes priority.
 */
function bundledPiBase(): string | undefined {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'harnesses/pi')
    : join(app.getAppPath(), 'resources/harnesses/pi')
  return existsSync(join(base, 'dist/bundle/rpc-entry.js')) ? base : undefined
}

/**
 * Vendor directory of the bundled Pi runtime (see `scripts/build-pi-harness.ts`),
 * or `undefined` when Pi is not bundled. Lets main-process features reuse the
 * libraries vendored beside the harness — e.g. pi-ai's headless OAuth flows —
 * which do not exist in the packaged app's own node_modules.
 */
export function bundledPiVendorDir(): string | undefined {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'harnesses/pi')
    : join(app.getAppPath(), 'resources/harnesses/pi')
  const vendor = join(base, 'vendor')
  return existsSync(vendor) ? vendor : undefined
}

/** The bundled Pi runtime, spawned via Electron's own embedded Node. */
function bundledPiRuntime(command: string): HarnessRuntime | null {
  if (command !== 'pi') return null
  const base = bundledPiBase()
  return base
    ? {
        command,
        executable: process.execPath,
        resolvedPath: join(base, 'dist/bundle/rpc-entry.js'),
        target: { kind: 'bundled' }
      }
    : null
}

/**
 * Env overrides for spawning the bundled Pi runtime: `ELECTRON_RUN_AS_NODE`
 * makes Electron's own binary behave as a plain Node runtime, and `NODE_PATH`
 * points at the bundled `vendor/` directory so `require('jiti')` resolves —
 * electron-builder's extraResources copy drops nested `node_modules`
 * directories, so that dependency ships under a differently named folder and
 * needs NODE_PATH instead of Node's standard `node_modules` upward walk.
 */
function bundledPiEnv(env: NodeJS.ProcessEnv, runtime: HarnessRuntime): NodeJS.ProcessEnv {
  const vendorDir = join(runtime.resolvedPath, '../../../vendor')
  const nodePath = [vendorDir, env['NODE_PATH']].filter(Boolean).join(delimiter)
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath }
}

const DISCOVERY_TIMEOUT_MS = 8_000
const PATH_TRANSLATION_TIMEOUT_MS = 5_000
const MAX_CAPTURE_BYTES = 256 * 1024
const RUNTIME_CACHE_TTL_MS = 60_000
const PATH_CACHE_TTL_MS = 5 * 60_000
const MAX_RUNTIME_CACHE_ENTRIES = 64
const MAX_PATH_CACHE_ENTRIES = 256
const NON_INTERACTIVE_WSL_DISTRIBUTIONS = new Set([
  'docker-desktop',
  'docker-desktop-data',
  'podman-machine-default'
])

export interface HarnessRuntime {
  command: string
  executable: string
  resolvedPath: string
  target: HarnessExecutionTarget
}

export interface PreparedHarnessInvocation {
  command: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  shell: boolean
  runtime: HarnessRuntime
}

export interface HarnessTerminalHandoff {
  command: string
  args: string[]
  runtime: HarnessRuntime
}

export interface WslTerminalHandoff {
  command: string
  args: string[]
}

interface CacheEntry<T> {
  value: T
  checkedAt: number
}

interface CaptureResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
}

const runtimeCache = new Map<string, CacheEntry<HarnessRuntime | null>>()
const pathCache = new Map<string, CacheEntry<string>>()
let distributionCache: CacheEntry<string[]> | null = null
let pathTranslationQueueTail: Promise<void> = Promise.resolve()

function pruneCache<T>(cache: Map<string, CacheEntry<T>>, maximum: number): void {
  while (cache.size > maximum) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') return
    cache.delete(oldest)
  }
}

function fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.checkedAt < ttl
}

function decodeWslOutput(value: Buffer): string {
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    return value.subarray(2).toString('utf16le')
  }
  let zeroBytes = 0
  for (let index = 1; index < value.length; index += 2) {
    if (value[index] === 0) zeroBytes += 1
  }
  return zeroBytes > value.length / 8 ? value.toString('utf16le') : value.toString('utf8')
}

function capture(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    shell?: boolean
    timeoutMs?: number
    maxOutputBytes?: number
  }
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let capturedBytes = 0
    let settled = false
    const finish = (result: CaptureResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.byteLength
      if (capturedBytes > (options.maxOutputBytes ?? MAX_CAPTURE_BYTES)) {
        settled = true
        clearTimeout(timer)
        child.kill()
        reject(new Error('Harness probe produced too much output'))
        return
      }
      target.push(chunk)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('Harness probe timed out'))
    }, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      finish({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

function wslExecutable(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') return undefined
  const systemPath = win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (existsSync(systemPath)) return systemPath
  return resolveExecutablePath('wsl.exe', env, 'win32')
}

async function wslDistributions(force = false): Promise<string[]> {
  if (!force && distributionCache && fresh(distributionCache, RUNTIME_CACHE_TTL_MS)) {
    return distributionCache.value
  }
  const env = buildProcessEnvironment()
  const executable = wslExecutable(env)
  if (!executable) return []
  try {
    const result = await capture(executable, ['--list', '--quiet'], { env })
    if (result.code !== 0) return []
    const distributions = decodeWslOutput(result.stdout)
      .split(/\r?\n/u)
      .map((value) => value.replace(/\0/gu, '').trim())
      .filter(
        (value) =>
          Boolean(value) && !NON_INTERACTIVE_WSL_DISTRIBUTIONS.has(value.toLocaleLowerCase('en-US'))
      )
    distributionCache = { value: [...new Set(distributions)], checkedAt: Date.now() }
    return distributionCache.value
  } catch {
    distributionCache = { value: [], checkedAt: Date.now() }
    return []
  }
}

function distributionFromUncPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  return /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/iu.exec(path)?.[1]
}

function orderedDistributions(distributions: string[], projectPath?: string): string[] {
  const preferred = distributionFromUncPath(projectPath)
  if (!preferred) return distributions
  const matching = distributions.find(
    (distribution) =>
      distribution.toLocaleLowerCase('en-US') === preferred.toLocaleLowerCase('en-US')
  )
  return matching ? [matching] : []
}

function runtimeCacheKey(command: string, projectPath?: string): string {
  return `${distributionFromUncPath(projectPath) ?? 'host'}\0${command}`
}

function nativeRuntime(command: string, env: NodeJS.ProcessEnv): HarnessRuntime | null {
  const executable = resolveExecutablePath(command, env)
  return executable
    ? { command, executable, resolvedPath: executable, target: { kind: 'native' } }
    : null
}

const WSL_DISCOVERY_SCRIPT =
  'login_path=$("${SHELL:-/bin/sh}" -lic \'printenv PATH\' 2>/dev/null || true); if [ -n "$login_path" ]; then PATH=$login_path; export PATH; fi; for command_name do command_path=$(command -v "$command_name" 2>/dev/null || true); printf "%s\\t%s\\n" "$command_name" "$command_path"; done'

async function discoverInDistribution(
  executable: string,
  distribution: string,
  commands: string[],
  env: NodeJS.ProcessEnv
): Promise<Map<string, string>> {
  try {
    const result = await capture(
      executable,
      ['--distribution', distribution, '--', 'sh', '-lc', WSL_DISCOVERY_SCRIPT, 'cio', ...commands],
      { env }
    )
    if (result.code !== 0) return new Map()
    const discovered = new Map<string, string>()
    for (const line of decodeWslOutput(result.stdout).split(/\r?\n/u)) {
      const separator = line.indexOf('\t')
      if (separator <= 0) continue
      const command = line.slice(0, separator).trim()
      const path = line.slice(separator + 1).trim()
      if (commands.includes(command) && path.startsWith('/')) discovered.set(command, path)
    }
    return discovered
  } catch {
    return new Map()
  }
}

/**
 * Resolve a group of harness commands in one bounded pass. Native commands win
 * for Windows projects. A project opened through a WSL UNC root prefers its own
 * distribution so Linux tools do not cross the filesystem boundary.
 */
export async function discoverHarnessRuntimes(
  commands: string[],
  options: { projectPath?: string; force?: boolean } = {}
): Promise<Map<string, HarnessRuntime | null>> {
  const uniqueCommands = [...new Set(commands)]
  const result = new Map<string, HarnessRuntime | null>()
  const missing: string[] = []
  const preferredDistribution = distributionFromUncPath(options.projectPath)
  const env = buildProcessEnvironment()

  for (const command of uniqueCommands) {
    const key = runtimeCacheKey(command, options.projectPath)
    const cached = runtimeCache.get(key)
    if (!options.force && fresh(cached, RUNTIME_CACHE_TTL_MS)) {
      result.set(command, cached.value)
      continue
    }
    const native = preferredDistribution ? null : nativeRuntime(command, env)
    if (native) result.set(command, native)
    else missing.push(command)
  }

  if (missing.length > 0 && process.platform === 'win32') {
    const executable = wslExecutable(env)
    const distributions = orderedDistributions(
      await wslDistributions(options.force),
      options.projectPath
    )
    if (executable) {
      for (const distribution of distributions) {
        const unresolved = missing.filter((command) => !result.has(command))
        if (unresolved.length === 0) break
        const discovered = await discoverInDistribution(executable, distribution, unresolved, env)
        for (const [command, resolvedPath] of discovered) {
          result.set(command, {
            command,
            executable,
            resolvedPath,
            target: { kind: 'wsl', distribution }
          })
        }
      }
    }
  }

  for (const command of missing) {
    if (!result.has(command)) {
      const native = nativeRuntime(command, env)
      result.set(command, native ?? bundledPiRuntime(command))
    }
  }
  for (const command of uniqueCommands) {
    const value = result.get(command) ?? null
    runtimeCache.set(runtimeCacheKey(command, options.projectPath), {
      value,
      checkedAt: Date.now()
    })
  }
  pruneCache(runtimeCache, MAX_RUNTIME_CACHE_ENTRIES)
  return result
}

export async function resolveHarnessRuntime(
  command: string,
  projectPath?: string
): Promise<HarnessRuntime | null> {
  return (await discoverHarnessRuntimes([command], { projectPath })).get(command) ?? null
}

function directWslPath(path: string, distribution: string): string | undefined {
  const match = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/iu.exec(path)
  if (!match || match[1]?.toLocaleLowerCase('en-US') !== distribution.toLocaleLowerCase('en-US')) {
    return undefined
  }
  const remainder = (match[2] ?? '').replace(/\\/gu, '/')
  return remainder || '/'
}

async function translatePath(runtime: HarnessRuntime, path: string): Promise<string> {
  if (runtime.target.kind !== 'wsl') return path
  const direct = directWslPath(path, runtime.target.distribution)
  if (direct) return direct
  const key = `${runtime.target.distribution}\0${path}`
  const cached = pathCache.get(key)
  if (fresh(cached, PATH_CACHE_TTL_MS)) return cached.value
  const preceding = pathTranslationQueueTail
  let release: () => void = () => undefined
  pathTranslationQueueTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await preceding
  try {
    const refreshed = pathCache.get(key)
    if (fresh(refreshed, PATH_CACHE_TTL_MS)) return refreshed.value
    const env = buildProcessEnvironment()
    const result = await capture(
      runtime.executable,
      ['--distribution', runtime.target.distribution, '--', 'wslpath', '-a', '-u', path],
      { env, timeoutMs: PATH_TRANSLATION_TIMEOUT_MS }
    )
    if (result.code !== 0) {
      const detail = decodeWslOutput(result.stderr).trim()
      throw new Error(detail || `WSL could not translate ${path}`)
    }
    const translated = decodeWslOutput(result.stdout).split(/\r?\n/u)[0]?.trim()
    if (!translated) throw new Error(`WSL returned an empty path for ${path}`)
    pathCache.set(key, { value: translated, checkedAt: Date.now() })
    pruneCache(pathCache, MAX_PATH_CACHE_ENTRIES)
    return translated
  } finally {
    release()
  }
}

function isWindowsPath(value: string): boolean {
  return win32.isAbsolute(value) || /^\\\\(?:wsl\$|wsl\.localhost)\\/iu.test(value)
}

async function translateArgument(runtime: HarnessRuntime, argument: string): Promise<string> {
  if (isWindowsPath(argument)) return translatePath(runtime, argument)
  const equals = argument.indexOf('=')
  if (equals > 0) {
    const value = argument.slice(equals + 1)
    if (isWindowsPath(value)) {
      return `${argument.slice(0, equals + 1)}${await translatePath(runtime, value)}`
    }
  }
  return argument
}

async function translateJsonPaths(
  runtime: HarnessRuntime,
  value: unknown,
  depth = 0
): Promise<unknown> {
  if (depth > 12) return value
  if (typeof value === 'string') {
    return isWindowsPath(value) ? translatePath(runtime, value) : value
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => translateJsonPaths(runtime, entry, depth + 1)))
  }
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [
        key,
        await translateJsonPaths(runtime, entry, depth + 1)
      ])
    )
  )
}

async function translateEnvironment(
  runtime: HarnessRuntime,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const translatedEntries = await Promise.all(
    Object.entries(env).map(async ([key, value]): Promise<[string, string | undefined]> => {
      if (value === undefined) return [key, value]
      if (WINDOWS_ONLY_ENVIRONMENT_KEYS.has(key.toUpperCase())) return [key, value]
      if (isWindowsPath(value)) return [key, await translatePath(runtime, value)]
      if (value.length > 4 * 1024 * 1024 || !/^\s*[[{]/u.test(value)) return [key, value]
      try {
        const parsed = JSON.parse(value) as unknown
        return [key, JSON.stringify(await translateJsonPaths(runtime, parsed))]
      } catch {
        return [key, value]
      }
    })
  )
  return Object.fromEntries(translatedEntries)
}

const WINDOWS_ONLY_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'WSLENV'
])

export function buildWslProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded = Object.entries(env)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) &&
        !WINDOWS_ONLY_ENVIRONMENT_KEYS.has(key.toUpperCase())
    )
    .map(([key, value]) => (value && isWindowsPath(value) ? `${key}/p` : key))
  const inherited = env['WSLENV']?.split(':').filter(Boolean) ?? []
  return { ...env, WSLENV: [...new Set([...inherited, ...forwarded])].join(':') }
}

function prepareNativeInvocation(
  runtime: HarnessRuntime,
  args: string[],
  env: NodeJS.ProcessEnv
): Pick<PreparedHarnessInvocation, 'command' | 'args' | 'shell'> {
  if (!commandRequiresShell(runtime.executable)) {
    return { command: runtime.command, args, shell: false }
  }
  const powershellShim = runtime.executable.replace(/\.(?:cmd|bat)$/iu, '.ps1')
  const fixedPowershell = win32.join(
    env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const powershell = existsSync(fixedPowershell)
    ? fixedPowershell
    : resolveExecutablePath('powershell.exe', env, 'win32')
  if (!powershell || !existsSync(powershellShim)) {
    throw new Error(
      `${runtime.command} uses a Windows command shim without a safe PowerShell companion`
    )
  }
  return {
    command: powershell,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powershellShim,
      ...args
    ],
    shell: false
  }
}

/** Prepare one harness launch while preserving structured arguments and stdio. */
export async function prepareHarnessInvocation(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<PreparedHarnessInvocation> {
  const env = options.env ?? buildProcessEnvironment()
  if (process.platform !== 'win32') {
    if (!resolveExecutablePath(command, env)) {
      const bundled = bundledPiRuntime(command)
      if (bundled) {
        return {
          command: bundled.executable,
          args: [bundled.resolvedPath, ...args],
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: bundledPiEnv(env, bundled),
          shell: false,
          runtime: bundled
        }
      }
    }
    return {
      command,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
      shell: false,
      runtime: { command, executable: command, resolvedPath: command, target: { kind: 'native' } }
    }
  }
  const runtime = await resolveHarnessRuntime(command, options.cwd)
  if (!runtime) throw new Error(`${command} was not found on Windows or in any WSL distribution`)
  if (runtime.target.kind === 'bundled') {
    return {
      command: runtime.executable,
      args: [runtime.resolvedPath, ...args],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: bundledPiEnv(env, runtime),
      shell: false,
      runtime
    }
  }
  if (runtime.target.kind === 'native') {
    const native = prepareNativeInvocation(runtime, args, env)
    return {
      command: native.command,
      args: native.args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
      shell: native.shell,
      runtime
    }
  }

  const [cwd, translatedArgs, translatedEnv] = await Promise.all([
    options.cwd
      ? translatePath(runtime, options.cwd)
      : Promise.resolve<string | undefined>(undefined),
    Promise.all(args.map((argument) => translateArgument(runtime, argument))),
    translateEnvironment(runtime, env)
  ])
  const launchArgs = [
    '--distribution',
    runtime.target.distribution,
    '--',
    'sh',
    '-c',
    'if [ "$1" = "__CIO_HOME__" ]; then cd -- "$HOME"; else cd -- "$1"; fi && shift && exec "$@"',
    'cio',
    cwd ?? '__CIO_HOME__',
    runtime.resolvedPath,
    ...translatedArgs
  ]
  return {
    command: runtime.executable,
    args: launchArgs,
    env: buildWslProcessEnvironment(translatedEnv),
    shell: false,
    runtime
  }
}

/** Prepare an interactive command for the user-visible terminal. */
export async function prepareHarnessTerminalHandoff(
  command: string,
  args: string[]
): Promise<HarnessTerminalHandoff> {
  const runtime = await resolveHarnessRuntime(command)
  if (!runtime) throw new Error(`${command} was not found on Windows or in any WSL distribution`)
  if (runtime.target.kind === 'bundled') {
    throw new Error(
      `${command} is bundled with CodeInOven — there is no CLI install to hand off to`
    )
  }
  if (runtime.target.kind === 'native') {
    return { command: runtime.executable, args, runtime }
  }
  return {
    command: runtime.executable,
    args: ['--distribution', runtime.target.distribution, '--', runtime.resolvedPath, ...args],
    runtime
  }
}

export function prepareWslTerminalHandoff(
  distribution: string,
  command: string,
  args: string[]
): WslTerminalHandoff {
  const executable = wslExecutable(buildProcessEnvironment())
  if (!executable) throw new Error('Windows Subsystem for Linux is unavailable')
  return {
    command: executable,
    args: ['--distribution', distribution, '--', command, ...args]
  }
}

function validateHarnessHomePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('WSL harness config path is invalid')
  }
}

export async function probeHarnessRuntime(
  runtime: HarnessRuntime,
  args: string[],
  env: NodeJS.ProcessEnv = buildProcessEnvironment()
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; reason: string }> {
  try {
    const command = runtime.executable
    const probeArgs =
      runtime.target.kind === 'wsl'
        ? ['--distribution', runtime.target.distribution, '--', runtime.resolvedPath, ...args]
        : runtime.target.kind === 'bundled'
          ? [runtime.resolvedPath, ...args]
          : args
    const result = await capture(command, probeArgs, {
      env:
        runtime.target.kind === 'wsl'
          ? buildWslProcessEnvironment(env)
          : runtime.target.kind === 'bundled'
            ? bundledPiEnv(env, runtime)
            : env,
      shell: runtime.target.kind === 'native' && commandRequiresShell(runtime.executable)
    })
    const stdout = decodeWslOutput(result.stdout)
    const stderr = decodeWslOutput(result.stderr)
    if (result.code === 0) return { ok: true, stdout, stderr }
    return {
      ok: false,
      reason:
        (stderr || stdout).split(/\r?\n/u)[0]?.trim() ||
        `Exited with code ${result.code ?? 'unknown'}`
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Run a finite harness command and collect bounded output. */
export async function runHarnessCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    maxOutputBytes?: number
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const prepared = await prepareHarnessInvocation(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  const result = await capture(prepared.command, prepared.args, {
    ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
    env: prepared.env,
    shell: prepared.shell,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {})
  })
  const stdout = decodeWslOutput(result.stdout)
  const stderr = decodeWslOutput(result.stderr)
  if (result.code !== 0) {
    throw new Error(
      (stderr || stdout).split(/\r?\n/u)[0]?.trim() ||
        `${command} exited with code ${result.code ?? 'unknown'}`
    )
  }
  return { stdout, stderr }
}

/**
 * Read a file below the harness owner's home directory. `undefined` means the
 * harness is native and the caller should use the host filesystem. `null`
 * means a WSL harness owns the file but it does not exist or cannot be read.
 */
export async function readHarnessHomeFile(
  command: string,
  relativePath: string,
  projectPath?: string
): Promise<string | null | undefined> {
  validateHarnessHomePath(relativePath)
  const runtime = await resolveHarnessRuntime(command, projectPath)
  if (!runtime || runtime.target.kind !== 'wsl') return undefined
  try {
    const result = await capture(
      runtime.executable,
      [
        '--distribution',
        runtime.target.distribution,
        '--',
        'sh',
        '-c',
        'cat -- "$HOME/$1"',
        'cio',
        relativePath
      ],
      { env: buildProcessEnvironment(), maxOutputBytes: 4 * 1024 * 1024 }
    )
    return result.code === 0 ? decodeWslOutput(result.stdout) : null
  } catch {
    return null
  }
}

/** Atomically write a file below a WSL harness owner's home directory. */
export async function writeHarnessHomeFile(
  command: string,
  relativePath: string,
  content: string
): Promise<boolean> {
  const runtime = await resolveHarnessRuntime(command)
  if (!runtime || runtime.target.kind !== 'wsl') return false
  const distribution = runtime.target.distribution
  validateHarnessHomePath(relativePath)
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) {
    throw new Error('WSL harness config content is invalid')
  }
  await new Promise<void>((resolve, reject) => {
    const script =
      'target="$HOME/$1"; directory=${target%/*}; mkdir -p -- "$directory"; temporary="$target.cio.$$"; trap \'rm -f -- "$temporary"\' EXIT HUP INT TERM; cat > "$temporary" && chmod 600 "$temporary" && mv -f -- "$temporary" "$target"; result=$?; trap - EXIT HUP INT TERM; exit $result'
    const child = spawn(
      runtime.executable,
      ['--distribution', distribution, '--', 'sh', '-c', script, 'cio', relativePath],
      {
        env: buildProcessEnvironment(),
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      }
    )
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('WSL harness config write timed out'))
    }, DISCOVERY_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString()
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      finish(
        code === 0
          ? undefined
          : new Error(stderr.trim() || `WSL harness config write exited with code ${code}`)
      )
    })
    child.stdin?.end(content)
  })
  return true
}
