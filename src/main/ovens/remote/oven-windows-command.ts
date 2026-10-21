/**
 * How the Oven service launches a command it resolved from PATH.
 *
 * `npm install -g` puts a `.cmd` shim on PATH for every harness on Windows, and
 * `CreateProcess` cannot start one: the spawn fails with `EINVAL`, so a probe
 * that spawned the shim directly failed as a whole and the app reported
 * "spawn EINVAL" instead of the Oven's harnesses. Version probes can use
 * `cmd.exe`; prompt-bearing runs resolve npm entrypoints and bypass the shell.
 *
 * Kept separate from the service entry so the quoting rules are unit-tested
 * without starting a service.
 */
import { open, access } from 'node:fs/promises'
import { win32 } from 'node:path'

export interface LaunchSpec {
  command: string
  args: string[]
  /** True when `args` is already one command line, so Node must not re-quote it. */
  verbatimArguments: boolean
}

/**
 * npm shims forward through cmd.exe, which truncates multiline arguments.
 * Resolve their literal package entrypoint instead. Only recognized forwarding
 * lines are accepted; arbitrary batch scripts are never interpreted here.
 */
export async function harnessLaunchSpec(
  path: string,
  args: readonly string[]
): Promise<LaunchSpec> {
  if (!isWindowsShim(path)) return launchSpec(path, args)
  const file = await open(path, 'r')
  let source: string
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    source = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
  const directory = win32.dirname(path)
  for (const line of source.split(/\r?\n/u)) {
    // Native npm bins, including @opencode/cli, forward directly to an exe.
    const native = /^\s*"%dp0%[\\/]([^"\r\n]+\.exe)"\s+%\*\s*$/iu.exec(line)
    if (native?.[1]) {
      const target = win32.resolve(directory, native[1])
      await access(target)
      return { command: target, args: [...args], verbatimArguments: false }
    }
    // Standard npm cmd-shim wrappers select node via %_prog%.
    const script =
      /^\s*(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*\s*$/iu.exec(
        line
      )
    if (script?.[1] && /SET\s+"?_prog=node(?:\.exe)?"?/iu.test(source)) {
      const target = win32.resolve(directory, script[1])
      await access(target)
      let node = win32.join(directory, 'node.exe')
      try {
        await access(node)
      } catch {
        node = process.execPath
      }
      return { command: node, args: [target, ...args], verbatimArguments: false }
    }
  }
  if (args.some((arg) => /[\r\n]/u.test(arg)))
    throw new Error(
      'This Windows harness shim cannot safely receive multiline prompts. Install a native executable or a standard npm shim.'
    )
  return launchSpec(path, args)
}

/** Whether a resolved path is a Windows shell shim rather than an executable. */
export function isWindowsShim(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/iu.test(path)
}

/**
 * Quote one argument so the program that receives it reads it back unchanged.
 *
 * These are `CommandLineToArgvW` rules, which is what the C runtime and Node use:
 * a run of backslashes is literal unless it precedes a quote, a quote is escaped
 * with a backslash, and the whole argument is wrapped when it holds a space.
 */
export function windowsArgument(value: string): string {
  if (value === '') return '""'
  if (!/[\s"]/u.test(value)) return value
  let escaped = ''
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      escaped += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    escaped += `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  escaped += '\\'.repeat(backslashes * 2)
  return `"${escaped}"`
}

/**
 * The program and arguments to spawn for one resolved command.
 *
 * A shim goes through `cmd.exe /d /s /c` with the command line built here and
 * `windowsVerbatimArguments` set, because Node would otherwise re-quote an
 * argument that is already a whole command line.
 */
export function launchSpec(
  path: string,
  args: readonly string[],
  options: { platform?: NodeJS.Platform; comspec?: string } = {}
): LaunchSpec {
  const platform = options.platform ?? process.platform
  if (!isWindowsShim(path, platform))
    return { command: path, args: [...args], verbatimArguments: false }
  const comspec = options.comspec ?? process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe'
  const commandLine = [path, ...args].map(windowsArgument).join(' ')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    verbatimArguments: true
  }
}
