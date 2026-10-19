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

export async function windowsGitRuntimeAt(root: string): Promise<WindowsGitRuntime | null> {
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
      if (!(await stat(file)).isFile()) return null
    }
    return { root, bash, ssh }
  } catch {
    return null
  }
}

let selected: WindowsGitRuntime | null = null
let cached: { key: string; runtime: WindowsGitRuntime | null; expires: number } | undefined

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
    ...pathRoots,
    ...common
  ]
  for (const root of new Set(roots)) {
    const runtime = await windowsGitRuntimeAt(root)
    if (runtime) {
      selected = runtime
      cached = { key, runtime, expires: Date.now() + 30_000 }
      return runtime
    }
  }
  selected = null
  cached = { key, runtime: null, expires: Date.now() + 5_000 }
  return null
}
