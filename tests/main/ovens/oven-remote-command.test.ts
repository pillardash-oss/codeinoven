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
    expect(command).toContain('node "$HOME/.config/pillardash/codeinoven/ovens/service.mjs" \'request\'')
  })

  it('passes a POSIX environment assignment ahead of node', () => {
    const command = remoteServiceCommand('posix', ['request'], {
      environment: { CODEINOVEN_OVEN_REVISION: 'abc' }
    })
    expect(command).toContain('CODEINOVEN_OVEN_REVISION=\'abc\' node ')
  })

  it('envelopes every Windows command as encoded PowerShell', () => {
    for (const shell of ['cmd', 'powershell'] as const) {
      expect(remoteServiceCommand(shell, ['request'])).toMatch(
        /^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/u
      )
    }
  })

  it('forwards stdin into the Windows service process', () => {
    const script = decode(remoteServiceCommand('cmd', ['request']))
    expect(script).toContain("Join-Path $env:USERPROFILE '.config\\pillardash\\codeinoven\\ovens'")
    expect(script).toContain("$data | & node $service 'request'")
    expect(script).toContain('exit $LASTEXITCODE')
  })

  it('verifies the bundle revision before installing on POSIX', () => {
    const command = remoteInstallServiceCommand('posix', 'deadbeef', 'token-1')
    expect(command).toContain('sha256sum')
    expect(command).toContain('shasum -a 256')
    expect(command).toContain("test \"$hash\" = 'deadbeef'")
    expect(command).toContain('CODEINOVEN_OVEN_REVISION=\'deadbeef\' node ')
    expect(command).toContain('service.token-1.next')
  })

  it('verifies the bundle revision before installing on Windows', () => {
    const script = decode(remoteInstallServiceCommand('cmd', 'deadbeef', 'token-1'))
    expect(script).toContain('Get-FileHash -Algorithm SHA256')
    expect(script).toContain("if ($actual -ne 'deadbeef')")
    expect(script).toContain("$env:CODEINOVEN_OVEN_REVISION = 'deadbeef'")
    expect(script).toContain('& node $service ensure')
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
    expect(decode(remoteArgvCommand('powershell', ['winget', 'install', "O'Brien"]))).toBe(
      "& 'winget' 'install' 'O''Brien'"
    )
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
})
