import { describe, expect, it } from 'vitest'
import {
  POSIX_NODE_CHECK,
  connectionInspectCommand,
  powershellLiteral,
  remoteArgvCommand,
  remoteInstallServiceCommand,
  remoteReadFileCommand,
  remoteServiceCommand,
  remoteTerminalCommand
} from '../../../src/main/ovens/oven-remote-command'

/** Decode the UTF-16LE script inside a `-EncodedCommand` invocation. */
function decode(script: string): string {
  const base64 = script.split(' -EncodedCommand ')[1]
  if (!base64) throw new Error('not an encoded command')
  return Buffer.from(base64, 'base64').toString('utf16le')
}

describe('oven remote commands', () => {
  it('runs the service with stdin on POSIX', () => {
    const command = remoteServiceCommand('posix', ['request'])
    expect(command).toContain(POSIX_NODE_CHECK)
    expect(command).toContain(
      'node "$HOME/.config/pillardash/codeinoven/ovens/service.mjs" \'request\''
    )
  })

  it('passes a POSIX environment assignment ahead of node', () => {
    const command = remoteServiceCommand('posix', ['request'], {
      environment: { CODEINOVEN_OVEN_REVISION: 'abc' }
    })
    expect(command).toContain("CODEINOVEN_OVEN_REVISION='abc' node ")
  })

  it('keeps the Windows service request out of PowerShell', () => {
    // PowerShell startup dominated every request on a Windows Oven, and every
    // screen made several of them; the request runs through cmd.exe instead.
    for (const shell of ['cmd', 'powershell'] as const) {
      expect(remoteServiceCommand(shell, ['request'])).toBe(
        'cmd /d /s /c node "%USERPROFILE%\\.config\\pillardash\\codeinoven\\ovens\\service.mjs" request'
      )
    }
  })

  it('forwards stdin into the Windows service process', () => {
    const command = remoteServiceCommand('cmd', ['request'])
    // Nothing reads stdin on the way: ssh hands it straight to node.
    expect(command).not.toContain('OpenStandardInput')
    expect(command.startsWith('cmd /d /s /c node ')).toBe(true)
  })

  it('verifies the bundle revision before installing on POSIX', () => {
    const command = remoteInstallServiceCommand('posix', 'deadbeef', 'token-1')
    expect(command).toContain('sha256sum')
    expect(command).toContain('shasum -a 256')
    expect(command).toContain('test "$hash" = \'deadbeef\'')
    expect(command).toContain("CODEINOVEN_OVEN_REVISION='deadbeef' node ")
    expect(command).toContain('service.token-1.next')
  })

  it('verifies the bundle revision before installing on Windows', () => {
    const revision = 'd'.repeat(64)
    const command = remoteInstallServiceCommand('cmd', revision, 'token-1')
    // The hash is checked in Node, which is the only runtime that can take the
    // bundle on stdin on Windows.
    expect(command).toContain("crypto.createHash('sha256')")
    expect(command).toContain(`expected='${revision}'`)
    expect(command).toContain('CODEINOVEN_OVEN_REVISION:expected')
    expect(command).toContain(",'ensure'")
    expect(command).toContain('process.exit(3)')
  })

  it('rejects an unsafe install token', () => {
    expect(() => remoteInstallServiceCommand('posix', 'rev', 'a;rm -rf /')).toThrow()
  })

  it('quotes structured argv per shell', () => {
    expect(remoteArgvCommand('posix', ['winget', 'install', 'Git.Git'])).toBe(
      "'winget' 'install' 'Git.Git'"
    )
    expect(remoteArgvCommand('posix', ['apt-get', 'update'], { elevated: true })).toContain(
      "'sudo' '-n' 'apt-get'"
    )
    // Windows runs structured argv through cmd.exe: PowerShell prefers the
    // `.ps1` beside an npm binary and the default ExecutionPolicy refuses it, so
    // a harness update failed for a shim the user's own shell could run.
    expect(decode(remoteArgvCommand('powershell', ['winget', 'install', "O'Brien"]))).toBe(
      "& cmd /d /s /c 'winget install O''Brien'"
    )
    expect(decode(remoteArgvCommand('cmd', ['opencode', 'upgrade']))).toBe(
      "& cmd /d /s /c 'opencode upgrade'"
    )
    expect(decode(remoteArgvCommand('cmd', ['winget', 'install', '--id', 'Git.Git']))).toBe(
      "& cmd /d /s /c 'winget install --id Git.Git'"
    )
  })

  it('refuses an argument a cmd.exe command line would reinterpret', () => {
    // cmd would expand or split on these, so the call reports the bad argument
    // instead of running something else than what was asked.
    expect(() => remoteArgvCommand('cmd', ['opencode', 'a&calc'])).toThrow('Invalid remote')
    expect(() => remoteArgvCommand('powershell', ['npm', 'install', '%PATH%'])).toThrow(
      'Invalid remote'
    )
    expect(() => remoteArgvCommand('cmd', ['node', 'a>b'])).toThrow('Invalid remote')
  })

  it('quotes PowerShell literals with doubled single quotes', () => {
    expect(powershellLiteral("a'b")).toBe("'a''b'")
  })

  it('inspects a Windows Oven over encoded PowerShell', () => {
    const script = decode(connectionInspectCommand('cmd'))
    expect(script).toContain("$lines.Add('Windows_NT')")
    expect(script).toContain('TotalPhysicalMemory')
    expect(script).toContain('not-installed')
  })

  it('reads a file with the shell that can read it', () => {
    expect(remoteReadFileCommand('posix', '/home/u/.ssh/known_hosts')).toBe(
      "cat '/home/u/.ssh/known_hosts'"
    )
    expect(decode(remoteReadFileCommand('cmd', 'C:\\Users\\u\\.ssh\\known_hosts'))).toContain(
      'Get-Content -LiteralPath'
    )
  })

  it('opens an interactive Windows shell that stays open', () => {
    const command = remoteTerminalCommand({
      shell: 'cmd',
      root: 'C:\\work',
      environment: { FOO: 'bar' },
      script: undefined
    })
    expect(command).toContain('-NoProfile -NoExit')
    const script = decode(command)
    expect(script).toContain("$env:FOO = 'bar'")
    expect(script).toContain("Set-Location -LiteralPath 'C:\\work'")
  })

  it('opens a bare Windows shell without an empty encoded command', () => {
    // The Oven's own shell passes no root, no environment and no script, so there
    // is nothing to encode. `-EncodedCommand` with no value made PowerShell print
    // its help and exit instead of opening a prompt.
    for (const shell of ['cmd', 'powershell'] as const) {
      const command = remoteTerminalCommand({
        shell,
        root: undefined,
        environment: {},
        script: undefined
      })
      expect(command).toBe('powershell -NoProfile -NoExit')
      expect(command).not.toContain('-EncodedCommand')
    }
  })

  it('runs an action script as a Windows child program', () => {
    const command = remoteTerminalCommand({
      shell: 'powershell',
      root: undefined,
      environment: {},
      script: 'echo hi'
    })
    expect(command).toContain('-NonInteractive')
    expect(decode(command)).toContain('& { echo hi }')
  })

  it('names the Windows service root once', () => {
    // It used to be composed by `Join-Path` in PowerShell, where nesting produced
    // `Join-Path Join-Path ...` and failed every Windows request. The cmd line
    // expands `%USERPROFILE%` itself, so the path is spelled once.
    const command = remoteServiceCommand('cmd', ['request'])
    expect(command).not.toContain('Join-Path')
    expect(command.match(/service\.mjs/gu)?.length).toBe(1)
    expect(command).toContain('%USERPROFILE%')
  })

  it('carries a Windows install through Node, not a PowerShell stdin read', () => {
    const revision = 'a'.repeat(64)
    const command = remoteInstallServiceCommand('cmd', revision, 'token-1')
    // A newline would end the remote command before Node ever started.
    expect(command).not.toContain('\n')
    expect(command.startsWith('node -e "')).toBe(true)
    expect(command.endsWith('"')).toBe(true)
    const program = command.slice('node -e "'.length, -1)
    // One quoting layer only: a double quote inside would break cmd.exe.
    expect(program).not.toContain('"')
    expect(program).toContain(`'${revision}'`)
    expect(program).toContain('spawnSync')
    // PowerShell cannot take the bundle on stdin: the read hung on a real Oven.
    expect(command).not.toContain('-EncodedCommand')
  })

  it('refuses a Windows install without a valid revision', () => {
    expect(() => remoteInstallServiceCommand('cmd', 'nope', 'token-1')).toThrow()
  })
})
