import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'

export interface WindowsGitRuntime {
  root: string
  bash: string
  ssh: string
}

export function managedWindowsGitDirectory(): string {
  return join(getConfigRoot(), 'runtimes', 'git-for-windows', 'portable')
}

/** Windows environment keys are case-insensitive, including PATH/Path. */
export function windowsPathValue(env: NodeJS.ProcessEnv): string {
  return env['PATH'] ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
}

/** Pure candidates keep frequent environment construction free of filesystem scans. */
export function commonWindowsGitRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env['ProgramFiles'] ? [join(env['ProgramFiles'], 'Git')] : []),
    ...(env['ProgramFiles(x86)'] ? [join(env['ProgramFiles(x86)'], 'Git')] : []),
    ...(env['LOCALAPPDATA'] ? [join(env['LOCALAPPDATA'], 'Programs', 'Git')] : []),
    ...(env['USERPROFILE'] ? [join(env['USERPROFILE'], 'scoop', 'apps', 'git', 'current')] : []),
    managedWindowsGitDirectory()
  ]
}

export function windowsGitBins(root: string): string[] {
  return [join(root, 'cmd'), join(root, 'bin'), join(root, 'usr', 'bin')]
}

export async function windowsGitRuntimeAt(
  root: string,
  deadline = Number.POSITIVE_INFINITY
): Promise<WindowsGitRuntime | null> {
  const bash = join(root, 'bin', 'bash.exe')
  const ssh = join(root, 'usr', 'bin', 'ssh.exe')
  try {
    for (const file of [
      bash,
      ssh,
      join(root, 'cmd', 'git.exe'),
      join(root, 'usr', 'bin', 'bash.exe'),
      join(root, 'usr', 'bin', 'msys-2.0.dll')
    ]) {
      if (Date.now() >= deadline) return null
      if (!(await stat(file)).isFile()) return null
    }
    return { root, bash, ssh }
  } catch {
    return null
  }
}

let selected: WindowsGitRuntime | null = null
let cached: { key: string; runtime: WindowsGitRuntime | null; expires: number } | undefined
const discovering = new Map<string, Promise<WindowsGitRuntime | null>>()

export function selectedWindowsGitRuntime(): WindowsGitRuntime | null {
  return selected
}

export function invalidateWindowsGitDiscovery(): void {
  cached = undefined
}

/** Sequential async probes keep network PATH entries and disk reads off the main thread. */
export async function findWindowsGitRuntime(
  env: NodeJS.ProcessEnv
): Promise<WindowsGitRuntime | null> {
  const bash = env['CLAUDE_CODE_GIT_BASH_PATH']
  const common = commonWindowsGitRoots(env)
  const path = windowsPathValue(env)
  const key = JSON.stringify([bash, path, common])
  if (cached?.key === key && cached.expires > Date.now()) return cached.runtime
  const existing = discovering.get(key)
  if (existing) return existing
  const discovery = discoverWindowsGitRuntime(bash, path, common, key)
  discovering.set(key, discovery)
  try {
    return await discovery
  } finally {
    discovering.delete(key)
  }
}

async function discoverWindowsGitRuntime(
  bash: string | undefined,
  path: string,
  common: string[],
  key: string
): Promise<WindowsGitRuntime | null> {
  const pathRoots = path
    .split(';')
    .filter(Boolean)
    .slice(0, 80)
    .flatMap((directory) => {
      const clean = directory.replace(/^"|"$/gu, '')
      return [clean, dirname(clean), dirname(dirname(clean))]
    })
  const roots = [
    ...(bash ? [dirname(dirname(bash)), dirname(dirname(dirname(bash)))] : []),
    ...(selected ? [selected.root] : []),
    ...common,
    ...pathRoots
  ]
  const deadline = Date.now() + 1_500
  const scan = async (): Promise<WindowsGitRuntime | null> => {
    for (const root of new Set(roots)) {
      if (Date.now() >= deadline) return null
      // An offline network PATH entry can hold a filesystem worker for minutes.
      if (/^(?:\\\\|\/\/)/u.test(root)) continue
      const runtime = await windowsGitRuntimeAt(root, deadline)
      if (Date.now() >= deadline) return null
      if (runtime) return runtime
    }
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let runtime: WindowsGitRuntime | null
  try {
    runtime = await Promise.race([
      scan(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_500)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  selected = runtime
  cached = { key, runtime, expires: Date.now() + (runtime ? 30_000 : 5_000) }
  return runtime
}
