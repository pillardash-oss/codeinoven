/** Native Windows tools for the generated, independently loaded Pi extension. */
export function piCoreToolsWindowsShellSource(): string {
  return String.raw`
  // These definitions run in the agent process, never Electron's main thread.
  function createCioWindowsShellTools(cwd) {
    if (process.platform !== 'win32') return []
    const tools = []
    const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const cmd = process.env.ComSpec || process.env.COMSPEC || join(system32, 'cmd.exe')

    function nativeOperations(executable, isPowerShell) {
      return {
        exec(command, cwd, options) {
          return new Promise((resolve, reject) => {
            if (options.signal?.aborted) {
              reject(new Error('Command aborted'))
              return
            }
            const script = isPowerShell
              ? "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0\n" + command + '\nexit $LASTEXITCODE'
              : command
            const args = isPowerShell
              ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
              : ['/d', '/s', '/c', '"' + script + '"']
            const child = spawn(executable, args, {
              cwd,
              // The app launches this agent with its normalized process environment.
              env: options.env || process.env,
              windowsHide: true,
              windowsVerbatimArguments: !isPowerShell,
              stdio: ['ignore', 'pipe', 'pipe']
            })
            let timer
            let stopped = false
            function stop() {
              if (stopped) return
              stopped = true
              // Kill descendants too, so cancelling a build leaves no orphaned worker.
              if (child.pid) {
                const killer = spawn(join(system32, 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {
                  windowsHide: true,
                  stdio: 'ignore'
                })
                killer.once('error', () => child.kill())
                killer.once('close', (code) => { if (code !== 0) child.kill() })
              } else {
                child.kill()
              }
            }
            function cleanup() {
              if (timer) clearTimeout(timer)
              options.signal?.removeEventListener('abort', stop)
            }
            child.stdout.on('data', options.onData)
            child.stderr.on('data', options.onData)
            child.once('error', (error) => {
              cleanup()
              reject(error)
            })
            child.once('close', (code) => {
              cleanup()
              if (stopped) reject(new Error(options.signal?.aborted ? 'Command aborted' : 'Command timed out'))
              else resolve({ exitCode: code })
            })
            options.signal?.addEventListener('abort', stop, { once: true })
            if (options.signal?.aborted) stop()
            if (options.timeout && options.timeout > 0) timer = setTimeout(stop, options.timeout * 1000)
          })
        }
      }
    }

    if (existsSync(powershell)) {
      tools.push(createPowerShellToolDefinition(cwd, {
        operations: nativeOperations(powershell, true)
      }))
    }
    const cmdDefinition = createBashToolDefinition(cwd, {
      operations: nativeOperations(cmd, false)
    })
    tools.push({
      ...cmdDefinition,
      name: 'cmd',
      label: 'CMD',
      description: 'Execute a Windows CMD.exe command in the project working directory. Use CMD syntax, including dir, type and where. Git Bash and PowerShell are not required. Output is streamed and truncated; timeout is in seconds.',
      promptSnippet: 'Execute native Windows CMD.exe commands without Git Bash',
      promptGuidelines: ['Use CMD syntax with cmd. Use powershell for PowerShell syntax. Use read, ls, find and grep directly to inspect project files.']
    })
    return tools
  }

  const windowsShellTools = createCioWindowsShellTools(process.cwd())
  for (const definition of windowsShellTools) pi.registerTool(definition)

  function applyCioWindowsShells() {
    if (windowsShellTools.length === 0) return
    let active = pi.getActiveTools()
    const allowed = loadCioAllowedTools()
    const nativeNames = windowsShellTools.map((tool) => tool.name)
    const scoped = active.filter((name) =>
      !nativeNames.includes(name) || allowed.length === 0 || allowed.includes(name)
    )
    if (scoped.length !== active.length) {
      pi.setActiveTools(scoped)
      active = scoped
    }
    // Never turn a deliberately shell-free session into a shell-enabled one.
    if (!active.some((name) => ['bash', 'powershell', 'cmd'].includes(name))) return
    const names = windowsShellTools.map((tool) => tool.name).filter((name) =>
      allowed.length === 0 || allowed.includes(name)
    )
    const missing = names.filter((name) => !active.includes(name))
    if (missing.length > 0) pi.setActiveTools([...active, ...missing])
  }

`
}
