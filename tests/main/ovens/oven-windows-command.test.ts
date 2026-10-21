import { describe, expect, it } from 'vitest'
import {
  isWindowsShim,
  launchSpec,
  windowsArgument
} from '../../../src/main/ovens/remote/oven-windows-command'

describe('isWindowsShim', () => {
  it('recognizes the npm shims Windows cannot execute itself', () => {
    expect(isWindowsShim('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd', 'win32')).toBe(true)
    expect(isWindowsShim('C:\\tools\\harness.BAT', 'win32')).toBe(true)
    expect(isWindowsShim('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false)
    expect(isWindowsShim('/usr/local/bin/opencode', 'darwin')).toBe(false)
    // A POSIX file that merely ends in .cmd is still an ordinary executable.
    expect(isWindowsShim('/tmp/harness.cmd', 'linux')).toBe(false)
  })
})

describe('windowsArgument', () => {
  it('leaves a plain argument alone', () => {
    expect(windowsArgument('--version')).toBe('--version')
    expect(windowsArgument('C:\\tools\\bin\\harness.exe')).toBe('C:\\tools\\bin\\harness.exe')
  })

  it('quotes an argument that holds spaces', () => {
    expect(windowsArgument('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"'
    )
    expect(windowsArgument('--model gpt')).toBe('"--model gpt"')
  })

  it('escapes quotes and the backslashes in front of them', () => {
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"')
    expect(windowsArgument('')).toBe('""')
  })

  it('doubles a trailing backslash so the closing quote stays a quote', () => {
    expect(windowsArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
  })
})

describe('launchSpec', () => {
  it('spawns an executable directly', () => {
    const spec = launchSpec('/usr/local/bin/opencode', ['--version'], { platform: 'darwin' })
    expect(spec).toEqual({
      command: '/usr/local/bin/opencode',
      args: ['--version'],
      verbatimArguments: false
    })
  })

  it('runs a Windows shim through cmd.exe, verbatim', () => {
    const spec = launchSpec('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd', ['--version'], {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe'
    })
    expect(spec.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.verbatimArguments).toBe(true)
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // cmd /s strips the outer quotes, so the shim runs as its own command.
    expect(spec.args[3]).toBe('"C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd --version"')
  })

  it('keeps a shim argument with spaces inside one token', () => {
    const spec = launchSpec('C:\\npm\\a.cmd', ['--text', 'two words'], {
      platform: 'win32',
      comspec: 'cmd.exe'
    })
    expect(spec.args[3]).toBe('"C:\\npm\\a.cmd --text "two words""')
  })
})
