import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  actionShellFamily,
  failFastActionScript
} from '../../../src/main/system/action-script-fail-fast'

describe('actionShellFamily', () => {
  it('reads the family from the shell binary name', () => {
    expect(actionShellFamily('/bin/zsh')).toBe('posix')
    expect(actionShellFamily('/bin/bash')).toBe('posix')
    expect(actionShellFamily('/bin/sh')).toBe('posix')
    expect(actionShellFamily('C:/Program Files/Git/bin/bash.exe')).toBe('posix')
    expect(actionShellFamily('/usr/local/bin/fish')).toBe('fish')
    expect(actionShellFamily('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')).toBe(
      'powershell'
    )
    expect(actionShellFamily('C:/Program Files/PowerShell/7/pwsh.exe')).toBe('powershell')
    expect(actionShellFamily('C:/Windows/System32/cmd.exe')).toBe('cmd')
  })
})

describe('failFastActionScript', () => {
  it('leaves an empty script alone', () => {
    expect(failFastActionScript('   \n', 'posix')).toBe('   \n')
  })

  it('stops a POSIX script at the first failing line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cio-action-'))
    const marker = join(dir, 'ran')
    const script = `false\ntouch ${marker}`
    try {
      const guarded = failFastActionScript(script, 'posix')
      const result = spawnSync('/bin/sh', ['-c', guarded])
      expect(result.status).toBe(1)
      expect(() => readFileSync(marker)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs every POSIX line when the failure is tolerated explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cio-action-'))
    const marker = join(dir, 'ran')
    try {
      const guarded = failFastActionScript(`set +e\nfalse\ntouch ${marker}`, 'posix')
      const result = spawnSync('/bin/sh', ['-c', guarded])
      expect(result.status).toBe(0)
      expect(readFileSync(marker, 'utf8')).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes CRLF line endings for POSIX shells', () => {
    expect(failFastActionScript('bun install\r\nbun run dev', 'posix')).toBe(
      'set -e\nbun install\nbun run dev'
    )
  })

  it('never adds the guard twice', () => {
    const guarded = failFastActionScript('bun install\nbun run dev', 'posix')
    expect(failFastActionScript(guarded, 'posix')).toBe(guarded)
    expect(failFastActionScript('set -eu\nbun install', 'posix')).toBe('set -eu\nbun install')
    expect(failFastActionScript('# build\nset -e\nbun install', 'posix')).toBe(
      '# build\nset -e\nbun install'
    )
  })

  it('raises PowerShell errors to terminating ones', () => {
    const guarded = failFastActionScript('bun run deploy', 'powershell')
    expect(guarded).toContain("$ErrorActionPreference = 'Stop'")
    expect(guarded).toContain('$PSNativeCommandUseErrorActionPreference = $true')
    expect(guarded.endsWith('bun run deploy')).toBe(true)
    expect(failFastActionScript(guarded, 'powershell')).toBe(guarded)
  })

  it('chains cmd lines with && and drops comments', () => {
    expect(failFastActionScript('bun install\r\n@REM build\r\nbun run dev', 'cmd')).toBe(
      'bun install && bun run dev'
    )
    expect(failFastActionScript('bun install', 'cmd')).toBe('bun install')
  })

  it('leaves a fish script untouched', () => {
    expect(failFastActionScript('bun install\nbun run dev', 'fish')).toBe(
      'bun install\nbun run dev'
    )
  })
})
