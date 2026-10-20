/**
 * How the Oven service launches a command it resolved from PATH.
 *
 * `npm install -g` puts a `.cmd` shim on PATH for every harness on Windows, and
 * `CreateProcess` cannot start one: the spawn fails with `EINVAL`, so a probe
 * that spawned the shim directly failed as a whole and the app reported
 * "spawn EINVAL" instead of the Oven's harnesses. Wrapping the command in
 * `cmd.exe` launches the shim exactly as a terminal would.
 *
 * Kept separate from the service entry so the quoting rules are unit-tested
 * without starting a service.
 */
export interface LaunchSpec {
  command: string
  args: string[]
  /** True when `args` is already one command line, so Node must not re-quote it. */
  verbatimArguments: boolean
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
